// ─────────────────────────────────────────────────────────────────────────────
// NNTrainer Visualizer — extension.js
//
// WHAT THIS FILE DOES (C++ analogy):
//   This is the "host process". Runs in Node.js with full access to:
//   - Filesystem  (read .ini and .bin files)
//   - VS Code API (panels, dialogs, file watchers, sidebar tree)
//   - Webview IPC (postMessage to/from the HTML visualizer)
//
// TRIGGERS:
//   1. Right-click .ini → "Open in NNTrainer Visualizer"
//   2. Command palette / Ctrl+Shift+V
//   3. Auto-detect: notification pops when .ini opened in editor
//   4. Sidebar icon in activity bar → lists all .ini files in workspace
//
// BIN LOADING: always via manual OS file picker dialog
// ─────────────────────────────────────────────────────────────────────────────

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');

// Global registry: iniPath → WebviewPanel
// Prevents duplicate panels for the same file
// Like std::map<string, Panel*>
const openPanels = new Map();

// ═════════════════════════════════════════════════════════════════════════════
// ACTIVATE
// ═════════════════════════════════════════════════════════════════════════════
function activate(context) {

  // ── TRIGGER 1: Right-click in file explorer ──────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('nntrainer.visualizeFromExplorer', (uri) => {
      if (!uri?.fsPath) return;
      openVisualizer(context, uri.fsPath);
    })
  );

  // ── TRIGGER 2: Command palette + Ctrl+Shift+V ────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('nntrainer.visualize', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('NNTrainer: Open a .ini model file first.');
        return;
      }
      if (!editor.document.uri.fsPath.endsWith('.ini')) {
        vscode.window.showErrorMessage('NNTrainer: Active file is not a .ini file.');
        return;
      }
      openVisualizer(context, editor.document.uri.fsPath);
    })
  );

  // ── PROFILER: open profiler panel for active .ini ───────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('nntrainer.openProfiler', () => {
      const editor = vscode.window.activeTextEditor;
      const iniPath = editor?.document?.uri?.fsPath?.endsWith('.ini')
        ? editor.document.uri.fsPath : null;
      openProfilerPanel(context, iniPath);
    })
  );

  // ── TRIGGER 3: Auto-detect when .ini opened in editor ────────────────────
  // Fires every time any file is opened — we filter to .ini only
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (!doc.uri.fsPath.endsWith('.ini')) return;

      // Only ask once per file per session
      const key = `nntrainer.asked.${doc.uri.fsPath}`;
      if (context.workspaceState.get(key)) return;
      context.workspaceState.update(key, true);

      // Quick check: does this look like an NNTrainer model?
      const text = doc.getText();
      const isModel = /\[Model\]/i.test(text) ||
        /type\s*=\s*(conv2d|fully_connected|input|embedding|lstm|attention|rms_norm)/i.test(text);
      if (!isModel) return;

      // Show a toast notification with action button
      vscode.window.showInformationMessage(
        `NNTrainer model detected: ${path.basename(doc.uri.fsPath)}`,
        'Open Visualizer', 'Dismiss'
      ).then(choice => {
        if (choice === 'Open Visualizer') openVisualizer(context, doc.uri.fsPath);
      });
    })
  );

  // ── TRIGGER 4: Sidebar tree view ─────────────────────────────────────────
  const sidebarProvider = new NNTrainerSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('nntrainerSidebar', sidebarProvider)
  );

  // Refresh button at top of sidebar panel
  context.subscriptions.push(
    vscode.commands.registerCommand('nntrainer.refreshSidebar', () => {
      sidebarProvider.refresh();
    })
  );

  // Called when user clicks a file in the sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand('nntrainer.openFromSidebar', (item) => {
      openVisualizer(context, item.filePath);
    })
  );

  // Watch for new/deleted .ini files → refresh sidebar automatically
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.ini');
  watcher.onDidCreate(() => sidebarProvider.refresh());
  watcher.onDidDelete(() => sidebarProvider.refresh());
  context.subscriptions.push(watcher);
}

// ═════════════════════════════════════════════════════════════════════════════
// SIDEBAR TREE PROVIDER
// Scans workspace for .ini files and lists them in the NNTrainer sidebar panel
// VS Code calls getChildren() to get the list, getTreeItem() to render each row
// ═════════════════════════════════════════════════════════════════════════════
class NNTrainerSidebarProvider {
  constructor(context) {
    this.context = context;
    // EventEmitter — fire this to tell VS Code to redraw the tree
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData  = this._onDidChangeTreeData.event;
  }

  refresh() { this._onDidChangeTreeData.fire(); }

  getTreeItem(element) { return element; }

  async getChildren(element) {
    if (element) return [];

    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      const msg = new vscode.TreeItem('Open a folder to scan for models');
      msg.iconPath = new vscode.ThemeIcon('info');
      return [msg];
    }

    // find all .ini files in workspace (like: find . -name "*.ini" | head -100)
    const uris = await vscode.workspace.findFiles('**/*.ini', '**/node_modules/**', 100);
    if (!uris.length) {
      const msg = new vscode.TreeItem('No .ini files found in workspace');
      msg.iconPath = new vscode.ThemeIcon('info');
      return [msg];
    }

    // Filter: only files that contain NNTrainer model sections
    const modelFiles = [];
    for (const uri of uris) {
      try {
        const text = fs.readFileSync(uri.fsPath, 'utf-8');
        if (
          /\[Model\]/i.test(text) ||
          /type\s*=\s*(conv2d|fully_connected|input|embedding|lstm|attention)/i.test(text)
        ) modelFiles.push(uri);
      } catch (_) {}
    }

    if (!modelFiles.length) {
      const msg = new vscode.TreeItem('No NNTrainer model .ini files found');
      msg.iconPath = new vscode.ThemeIcon('info');
      return [msg];
    }

    // Build a TreeItem for each model file
    return modelFiles.map(uri => {
      const fileName  = path.basename(uri.fsPath);
      const parentDir = path.basename(path.dirname(uri.fsPath));

      const item           = new vscode.TreeItem(fileName, vscode.TreeItemCollapsibleState.None);
      item.description     = parentDir;             // greyed-out text on the right
      item.tooltip         = uri.fsPath;            // shown on hover
      item.contextValue    = 'iniFile';             // used in package.json menus
      item.filePath        = uri.fsPath;            // our custom property
      item.iconPath        = new vscode.ThemeIcon('circuit-board');

      // Single click → open visualizer
      item.command = {
        command:   'nntrainer.openFromSidebar',
        title:     'Open Visualizer',
        arguments: [item]
      };
      return item;
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// OPEN VISUALIZER PANEL
// ═════════════════════════════════════════════════════════════════════════════
function openVisualizer(context, iniPath) {

  // Reuse existing panel if already open for this file
  if (openPanels.has(iniPath)) {
    openPanels.get(iniPath).reveal(vscode.ViewColumn.Beside);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'nntrainerVisualizer',
    `⬡ ${path.basename(iniPath)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts:           true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(context.extensionPath, 'media'))
      ]
    }
  );

  openPanels.set(iniPath, panel);
  panel.onDidDispose(() => openPanels.delete(iniPath));
  panel.webview.html = getWebviewHtml(context, panel.webview);

  // ── Messages from webview → extension ────────────────────────────────────
  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'READY':
        // Webview is ready — send the .ini file text
        sendIniFile(panel, iniPath);
        break;

      case 'PICK_BIN':
        // Webview wants user to pick a .bin file
        await pickAndLoadBin(panel, iniPath, msg.layers);
        break;

      case 'PICK_PROFILE':
        // Webview wants user to pick a profile JSON
        await pickAndLoadProfile(panel);
        break;

      case 'PROFILER_SELECT_LAYER':
        // Profiler asked us to highlight a layer in the visualizer — forward if open
        if (openPanels.has(iniPath)) {
          openPanels.get(iniPath).webview.postMessage({
            type: 'SELECT_LAYER_FROM_PROFILER', id: msg.id
          });
        }
        break;
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SEND .INI FILE TEXT TO WEBVIEW
// ═════════════════════════════════════════════════════════════════════════════
function sendIniFile(panel, iniPath) {
  try {
    const text = fs.readFileSync(iniPath, 'utf-8');
    panel.webview.postMessage({
      type: 'INI_TEXT',
      data: { text, fileName: path.basename(iniPath) }
    });
  } catch (err) {
    panel.webview.postMessage({
      type: 'ERROR',
      data: { message: `Cannot read .ini file:\n${err.message}` }
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MANUAL .BIN FILE PICKER
// Shows OS file picker → reads file → parses weights → sends stats to webview
// ═════════════════════════════════════════════════════════════════════════════
async function pickAndLoadBin(panel, iniPath, layers) {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles:   true,
    canSelectMany:    false,
    canSelectFolders: false,
    filters:          { 'NNTrainer Weight Files': ['bin'] },
    defaultUri:       vscode.Uri.file(path.dirname(iniPath)),
    openLabel:        'Load Weights'
  });

  if (!uris?.[0]) return; // user cancelled

  const binPath = uris[0].fsPath;

  panel.webview.postMessage({
    type: 'BIN_START',
    data: { fileName: path.basename(binPath) }
  });

  await parseBinAndSend(panel, binPath, layers);
}

// ═════════════════════════════════════════════════════════════════════════════
// BIN PARSER
// Reads sequential float32 tensors, computes stats per tensor
// ═════════════════════════════════════════════════════════════════════════════
async function parseBinAndSend(panel, binPath, layers) {
  try {
    const fileSize = fs.statSync(binPath).size;
    const fd       = fs.openSync(binPath, 'r');
    const result   = {};
    let   offset   = 0;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];

      panel.webview.postMessage({
        type: 'BIN_PROGRESS',
        data: { pct: Math.round((i / layers.length) * 100), layerName: layer.fullName }
      });

      // Yield every 20 layers so the UI stays responsive
      if (i % 20 === 0) await sleep(0);

      const tensorStats = [];

      for (const tensor of layer.weightTensors) {
        if (!tensor.bytes || offset + tensor.bytes > fileSize) {
          tensorStats.push(null); continue;
        }

        // Read tensor.bytes bytes at position offset
        // C equivalent: fseek(fd, offset, SEEK_SET); fread(buf, 1, bytes, fd);
        const buf = Buffer.alloc(tensor.bytes);
        fs.readSync(fd, buf, 0, tensor.bytes, offset);
        offset += tensor.bytes;

        // Reinterpret as float32 — like (float*)buf in C
        const count = tensor.bytes / 4;
        const f32   = new Float32Array(buf.buffer, buf.byteOffset, count);

        // Pass 1: min, max, mean
        let mn = Infinity, mx = -Infinity, sum = 0;
        for (let j = 0; j < f32.length; j++) {
          if (f32[j] < mn) mn = f32[j];
          if (f32[j] > mx) mx = f32[j];
          sum += f32[j];
        }
        const mean = sum / f32.length;

        // Pass 2: std deviation
        let variance = 0;
        for (let j = 0; j < f32.length; j++) variance += (f32[j] - mean) ** 2;
        const std = Math.sqrt(variance / f32.length);

        // Pass 3: 24-bin histogram
        const BINS = 24, hist = new Array(BINS).fill(0);
        const range = (mx - mn) || 1e-9;
        for (let j = 0; j < f32.length; j++) {
          hist[Math.min(BINS - 1, Math.floor(((f32[j] - mn) / range) * BINS))]++;
        }

        // L2 norm and RMS norm (weight health indicators / proxy for gradient norms)
        let sumSq = 0;
        for (let j = 0; j < f32.length; j++) sumSq += f32[j] * f32[j];
        const l2Norm  = Math.sqrt(sumSq);
        const rmsNorm = Math.sqrt(sumSq / f32.length);

        tensorStats.push({ name: tensor.name, shape: tensor.shape, min: mn, max: mx, mean, std, hist, count: f32.length, l2Norm, rmsNorm });
      }

      if (tensorStats.some(Boolean)) result[layer.id] = tensorStats.filter(Boolean);
    }

    fs.closeSync(fd);

    panel.webview.postMessage({
      type: 'BIN_LOADED',
      data: { stats: result, fileName: path.basename(binPath), fileSize }
    });

  } catch (err) {
    panel.webview.postMessage({
      type: 'ERROR',
      data: { message: `Failed to parse .bin:\n${err.message}` }
    });
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getNonce() {
  let n = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) n += c[Math.floor(Math.random() * c.length)];
  return n;
}

function getWebviewHtml(context, webview) {
  const htmlPath = path.join(context.extensionPath, 'media', 'visualizer.html');
  let   html     = fs.readFileSync(htmlPath, 'utf-8');
  const nonce    = getNonce();
  const mediaUri = webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'media')));
  html = html.replace(/\$\{nonce\}/g,    nonce);
  html = html.replace(/\$\{mediaUri\}/g, mediaUri.toString());
  return html;
}

// ═════════════════════════════════════════════════════════════════════════════
// PROFILE JSON LOADER
// Reads an NNTrainer profile JSON (produced by C++ profiling patch) and
// forwards it to the webview so it can render timing, memory, throughput.
//
// Expected JSON schema:
//   { model_name, batch_size, iterations,
//     throughput_samples_per_sec, total_fwd_ms, total_bwd_ms,
//     layers: { layerId: { fwd_ms, bwd_ms, peak_mem_bytes, grad_norm } } }
// ═════════════════════════════════════════════════════════════════════════════
async function pickAndLoadProfile(panel) {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles:   true,
    canSelectMany:    false,
    canSelectFolders: false,
    filters:          { 'NNTrainer Profile': ['json'], 'All Files': ['*'] },
    openLabel:        'Load Profile'
  });
  if (!uris?.[0]) return;

  try {
    const text    = fs.readFileSync(uris[0].fsPath, 'utf-8');
    const profile = JSON.parse(text);
    panel.webview.postMessage({ type: 'PROFILE_LOADED', data: profile });
  } catch (err) {
    panel.webview.postMessage({
      type: 'ERROR',
      data: { message: `Failed to parse profile JSON:\n${err.message}` }
    });
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// PROFILER PANEL
// Opens a separate webview panel (ViewColumn.Beside) that SSHes into the
// Ubuntu server, runs NNTrainer with -DPROFILE, captures stdout line-by-line,
// parses GenericProfileListener::report() format, streams results to
// profiler.html via postMessage.
// ═════════════════════════════════════════════════════════════════════════════
const profilerPanels = new Map();
let   activeProfilerProcess = null;

function openProfilerPanel(context, iniPath) {
  const key = iniPath || '__global__';
  if (profilerPanels.has(key)) {
    profilerPanels.get(key).reveal(vscode.ViewColumn.Beside);
    return;
  }

  const panelTitle = iniPath ? `⏱ ${path.basename(iniPath)}` : '⏱ NNTrainer Profiler';
  const panel = vscode.window.createWebviewPanel(
    'nntrainerProfiler', panelTitle, vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))] }
  );

  profilerPanels.set(key, panel);
  panel.onDidDispose(() => { profilerPanels.delete(key); stopProfilerProcess(); });
  panel.webview.html = getProfilerHtml(context, panel.webview);

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'PROFILER_READY': break;
      case 'PROFILER_RUN':   await runProfiler(panel, context, iniPath); break;
      case 'PROFILER_STOP':
        stopProfilerProcess();
        panel.webview.postMessage({ type: 'PROF_DONE', data: {} });
        break;
      case 'PROFILER_SELECT_LAYER':
        if (iniPath && openPanels.has(iniPath))
          openPanels.get(iniPath).webview.postMessage({ type: 'SELECT_LAYER_FROM_PROFILER', id: msg.id });
        break;
    }
  });
}

// ─── SSH runner ───────────────────────────────────────────────────────────────
async function runProfiler(panel, context, iniPath) {
  const config    = vscode.workspace.getConfiguration('nntrainer');
  const sshHost   = config.get('ssh.host',      'test@107.99.46.57');
  const sshKey    = config.get('ssh.keyPath',    '');
  const remoteDir = config.get('ssh.remoteDir',  '/storage_data/Snap/nntrainer');
  const buildDir  = config.get('ssh.buildDir',   'build');
  const appBin    = config.get('ssh.appBinary',  '');
  const modelName = iniPath ? path.basename(iniPath, '.ini') : 'model';
  const remoteIni = iniPath ? `${remoteDir}/${path.basename(iniPath)}` : '';

  panel.webview.postMessage({ type: 'PROF_START', data: { host: sshHost, modelName } });

  // Command that runs NNTrainer with profiling enabled
  const remoteCmd = appBin
    ? `cd ${remoteDir} && PROFILE=1 ./${buildDir}/${appBin} ${remoteIni} 2>&1`
    : `cd ${remoteDir} && PROFILE=1 ./${buildDir}/test/unittest/unittest_nntrainer_modelfile 2>&1`;

  const sshArgs = [];
  if (sshKey) sshArgs.push('-i', sshKey);
  sshArgs.push(sshHost, remoteCmd);

  panel.webview.postMessage({ type: 'PROF_LOG', data: { text: `> ssh ${sshHost}`, cls: 'log-info' } });
  panel.webview.postMessage({ type: 'PROF_LOG', data: { text: `> ${remoteCmd}`,   cls: 'log-info' } });

  const { spawn } = require('child_process');
  const proc = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  activeProfilerProcess = proc;

  // Parser state
  const layerTimings = {};
  let totalAlloc = 0, peakAlloc = 0, iterCount = 0;
  let inTimeSection = false, inMemSection = false, lineBuffer = '';

  function parseLine(raw) {
    const line = raw.trimEnd();
    if (!line) return;

    if (/time\s+profile/i.test(line))   { inTimeSection = true;  inMemSection = false; return; }
    if (/memory\s+profile/i.test(line)) { inMemSection  = true;  inTimeSection = false; return; }

    // ── Time profile: "[Forwarding for layer: X]  cur: 145234us  ...  cnt: 100"
    if (inTimeSection) {
      const tm = line.match(/\[([^\]]+)\]\s+cur:\s*([\d.]+)us.*cnt:\s*(\d+)/i);
      if (tm) {
        const label = tm[1].trim();
        const ms    = parseFloat(tm[2]) / 1000;
        const cnt   = parseInt(tm[3]);
        const fwdM  = label.match(/^Forwarding for layer:\s*(.+)$/i);
        const bwdM  = label.match(/^(?:CalcGradient|CalcDerivative|ApplyGradient):\s*(.+)$/i);
        const lname = (fwdM || bwdM)?.[1]?.trim();
        if (lname) {
          if (!layerTimings[lname]) layerTimings[lname] = { name: lname, fwd_ms: 0, bwd_ms: 0, calls: 0 };
          if (fwdM) { layerTimings[lname].fwd_ms += ms; layerTimings[lname].calls = cnt; }
          else        layerTimings[lname].bwd_ms += ms;
          iterCount = Math.max(iterCount, cnt);
          panel.webview.postMessage({ type: 'PROF_LAYER', data: {
            id: lname, name: lname,
            fwd_ms: layerTimings[lname].fwd_ms,
            bwd_ms: layerTimings[lname].bwd_ms,
            calls: cnt, backend: guessBackend(lname),
          }});
        }
        return;
      }
    }

    // ── Memory profile: "ALLOC 0x... <bytes> <label> total: <bytes>"
    if (inMemSection) {
      const am = line.match(/ALLOC\s+\S+\s+(\d+).*total:\s*(\d+)/i);
      if (am) {
        totalAlloc = parseInt(am[2]);
        peakAlloc  = Math.max(peakAlloc, totalAlloc);
        panel.webview.postMessage({ type: 'PROF_MEM', data: { iter: iterCount, bytes: totalAlloc } });
      }
    }

    // Route errors to log
    if (/error/i.test(line))
      panel.webview.postMessage({ type: 'PROF_LOG', data: { text: line, cls: 'log-err' } });
    else if (line.startsWith('[') || /profile/i.test(line))
      panel.webview.postMessage({ type: 'PROF_LOG', data: { text: line, cls: 'log-parse' } });
  }

  proc.stdout.on('data', chunk => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer  = lines.pop();
    for (const l of lines) parseLine(l);
  });
  proc.stderr.on('data', chunk => {
    const t = chunk.toString().trim();
    if (t) panel.webview.postMessage({ type: 'PROF_LOG', data: { text: t, cls: 'log-err' } });
  });
  proc.on('close', code => {
    if (lineBuffer) parseLine(lineBuffer);
    const totalFwd = Object.values(layerTimings).reduce((s, l) => s + (l.fwd_ms || 0), 0);
    const totalBwd = Object.values(layerTimings).reduce((s, l) => s + (l.bwd_ms || 0), 0);
    panel.webview.postMessage({ type: 'PROF_TOTALS', data: { totalFwd, totalBwd, iterations: iterCount } });
    panel.webview.postMessage({ type: code === 0 ? 'PROF_DONE' : 'PROF_ERROR',
      data: { message: code !== 0 ? `SSH exited with code ${code}` : '' } });
    activeProfilerProcess = null;
  });
  proc.on('error', err => {
    panel.webview.postMessage({ type: 'PROF_ERROR', data: { message: `SSH spawn failed: ${err.message}` } });
  });
}

function stopProfilerProcess() {
  if (activeProfilerProcess) {
    try { activeProfilerProcess.kill('SIGTERM'); } catch (_) {}
    activeProfilerProcess = null;
  }
}

function guessBackend(name) {
  const n = name.toLowerCase();
  if (n.includes('gpu') || n.includes('cuda') || n.includes('opencl')) return 'GPU';
  if (n.includes('npu') || n.includes('nns'))  return 'NPU';
  return 'CPU';
}

function getProfilerHtml(context, webview) {
  const htmlPath = path.join(context.extensionPath, 'media', 'profiler.html');
  let   html     = fs.readFileSync(htmlPath, 'utf-8');
  html = html.replace(/\$\{nonce\}/g, getNonce());
  return html;
}

function deactivate() { stopProfilerProcess(); }
module.exports = { activate, deactivate };
