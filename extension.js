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
      const editor  = vscode.window.activeTextEditor;
      const iniPath = editor?.document?.uri?.fsPath?.endsWith('.ini')
        ? editor.document.uri.fsPath : null;
      openProfilerPanel(context, iniPath);
    })
  );

  // ── PROFILER: right-click in explorer ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('nntrainer.openProfilerFromExplorer', (uri) => {
      if (!uri?.fsPath) return;
      openProfilerPanel(context, uri.fsPath);
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
// Opens a separate webview on the right. User picks a profile .txt file
// generated by running NNTrainer with -DPROFILE. The extension parses the
// GenericProfileListener::report() output and sends structured data to
// profiler.html via postMessage.
// ═════════════════════════════════════════════════════════════════════════════
const profilerPanels = new Map();

function openProfilerPanel(context, iniPath) {
  const key = iniPath || '__global__';
  if (profilerPanels.has(key)) {
    profilerPanels.get(key).reveal(vscode.ViewColumn.Beside);
    return;
  }

  const panelTitle = iniPath ? `⏱ ${path.basename(iniPath)}` : '⏱ NNTrainer Profiler';
  const panel = vscode.window.createWebviewPanel(
    'nntrainerProfiler', panelTitle, vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
    }
  );

  profilerPanels.set(key, panel);
  panel.onDidDispose(() => profilerPanels.delete(key));
  panel.webview.html = getProfilerHtml(context, panel.webview);

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'PROFILER_READY':
        break;

      case 'PROFILER_PICK_FILE':
        await pickAndParseProfileFile(panel);
        break;

      case 'PROFILER_SELECT_LAYER':
        // Cross-link: highlight layer in the visualizer panel if open
        if (iniPath && openPanels.has(iniPath)) {
          openPanels.get(iniPath).webview.postMessage({
            type: 'SELECT_LAYER_FROM_PROFILER', id: msg.id
          });
        }
        break;
    }
  });
}

// ─── File picker + parser ────────────────────────────────────────────────────
async function pickAndParseProfileFile(panel) {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles:   true,
    canSelectMany:    false,
    canSelectFolders: false,
    filters: {
      'NNTrainer Profile Output': ['txt', 'log', 'out'],
      'All Files': ['*']
    },
    openLabel: 'Load Profile'
  });

  if (!uris?.[0]) return;

  try {
    const text     = fs.readFileSync(uris[0].fsPath, 'utf-8');
    const fileName = path.basename(uris[0].fsPath);
    const parsed   = parseProfileOutput(text);

    panel.webview.postMessage({
      type: 'PROFILE_DATA',
      data: { ...parsed, fileName }
    });
  } catch (err) {
    panel.webview.postMessage({
      type: 'PROFILE_ERROR',
      data: { message: err.message }
    });
  }
}

// ─── Parser for GenericProfileListener::report() stdout output ───────────────
//
// NNTrainer profile output format (when built with -DPROFILE):
//
// Time profile:
//   [Forwarding for layer: embedding_layer]  cur: 145234us  min: 140123us  max: 160000us  avg: 148000us  cnt: 100
//   [CalcGradient: embedding_layer]          cur:  98123us  min:  95000us  max: 105000us  avg:  97000us  cnt: 100
//   [CalcDerivative: embedding_layer]        cur:  48000us  min:  45000us  max:  52000us  avg:  49000us  cnt: 100
//
// Memory profile:
//   ALLOC   0x7f1234  4194304  "embedding_layer weight"  total: 4194304
//   ALLOC   0x7f5678  4194304  "embedding_layer bias"    total: 8388608
//   ANNOTATE  "Forwarding for layer: embedding_layer"
//   DEALLOC 0x7f1234  total: 4194304
//
function parseProfileOutput(text) {
  const layers    = {};
  const memSeries = [];
  let   totalAlloc  = 0;
  let   maxIter     = 0;
  let   inTime      = false;
  let   inMem       = false;
  let   memIter     = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    // Section headers
    if (/^time\s+profile/i.test(line))   { inTime = true;  inMem = false;  continue; }
    if (/^memory\s+profile/i.test(line)) { inMem  = true;  inTime = false; continue; }

    // ── Time profile line ────────────────────────────────────────────────────
    // "[label]  cur: Xus  min: Xus  max: Xus  avg: Xus  cnt: N"
    if (inTime) {
      const m = line.match(/\[([^\]]+)\]\s+cur:\s*([\d.]+)us.*?cnt:\s*(\d+)/i);
      if (!m) continue;

      const label   = m[1].trim();
      const avgMs   = parseFloat(m[2]) / 1000;   // use cur as the measured value
      const cnt     = parseInt(m[3]);

      // also try to get avg if present: "avg: Xus"
      const avgM = line.match(/avg:\s*([\d.]+)us/i);
      const ms   = avgM ? parseFloat(avgM[1]) / 1000 : avgMs;

      maxIter = Math.max(maxIter, cnt);

      // Classify by label prefix
      const fwdM = label.match(/^Forwarding for layer:\s*(.+)$/i);
      const bwdM = label.match(/^(?:CalcGradient|CalcDerivative|ApplyGradient):\s*(.+)$/i);
      const initM= label.match(/^(?:Initialize|Reinitialize|PROFILE_MEM_ANNOTATE):\s*(.+)$/i);

      const layerName = (fwdM || bwdM || initM)?.[1]?.trim();
      if (!layerName) continue;

      if (!layers[layerName]) {
        layers[layerName] = {
          id: layerName, name: layerName,
          fwd_ms: 0, bwd_ms: 0, mem_bytes: 0, calls: 0,
          backend: 'CPU'
        };
      }

      if (fwdM) {
        layers[layerName].fwd_ms += ms;
        layers[layerName].calls   = cnt;
      } else if (bwdM) {
        layers[layerName].bwd_ms += ms;
      }
      continue;
    }

    // ── Memory profile lines ─────────────────────────────────────────────────
    if (inMem) {
      // ALLOC line: track cumulative total
      const allocM = line.match(/^ALLOC\s+\S+\s+(\d+)\s+.*total:\s*(\d+)/i);
      if (allocM) {
        totalAlloc = parseInt(allocM[2]);
        memSeries.push({ iter: memIter++, bytes: totalAlloc });
        continue;
      }

      // DEALLOC line: update total
      const deallocM = line.match(/^DEALLOC\s+\S+.*total:\s*(\d+)/i);
      if (deallocM) {
        totalAlloc = parseInt(deallocM[1]);
        memSeries.push({ iter: memIter++, bytes: totalAlloc });
        continue;
      }

      // ANNOTATE: "Forwarding for layer: X" — attach mem snapshot to layer
      const annM = line.match(/^ANNOTATE\s+"?(.+?)"?\s*$/i);
      if (annM) {
        const ann    = annM[1].trim();
        const fwdM2  = ann.match(/^Forwarding for layer:\s*(.+)$/i);
        if (fwdM2) {
          const lname = fwdM2[1].trim();
          if (layers[lname]) layers[lname].mem_bytes = totalAlloc;
        }
        continue;
      }
    }
  }

  // Downsample memory series if too long (keep max 300 points for chart perf)
  let finalMemSeries = memSeries;
  if (memSeries.length > 300) {
    const step = Math.ceil(memSeries.length / 300);
    finalMemSeries = memSeries.filter((_, i) => i % step === 0);
  }

  return {
    layers:     Object.values(layers),
    memSeries:  finalMemSeries,
    iterations: maxIter,
  };
}

function getProfilerHtml(context, webview) {
  const htmlPath = path.join(context.extensionPath, 'media', 'profiler.html');
  let   html     = fs.readFileSync(htmlPath, 'utf-8');
  const nonce    = getNonce();
  html = html.replace(/PROFILER_NONCE/g, nonce);
  return html;
}

function deactivate() {}
module.exports = { activate, deactivate };
