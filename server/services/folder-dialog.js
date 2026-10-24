import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uid } from '../util.js';

let chain = Promise.resolve();

/** Windows 系统文件夹选择对话框（由本机桌面弹出） */
async function showFolderDialog({ title = '选择视频文件夹', timeoutMs = 5 * 60_000 } = {}) {
  // 测试模式：不弹窗，直接返回预设路径
  if (process.env.WXA_DIALOG_TEST_PATH) return { path: process.env.WXA_DIALOG_TEST_PATH, test: true };
  if (process.platform !== 'win32') {
    throw new Error('当前系统不支持系统文件夹选择对话框，请手动输入路径');
  }
  const resultFile = path.join(os.tmpdir(), `wxa-folder-${uid('dlg_')}.txt`);
  // 说明：由后台 Node 进程拉起的对话框容易被浏览器/其它窗口盖住，
  // 这里创建一个 TopMost 的隐藏 owner 窗口来承载对话框，确保对话框出现在最前面。
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    'Add-Type -AssemblyName System.Drawing | Out-Null',
    'Add-Type -Namespace WxaDialog -Name Native -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\' | Out-Null',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
    `$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized`,
    '$owner.Size = New-Object System.Drawing.Size(1, 1)',
    `$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual`,
    '$owner.Location = New-Object System.Drawing.Point(-4000, -4000)',
    '$owner.Show()',
    '[System.Windows.Forms.Application]::DoEvents()',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = '${String(title).replace(/'/g, "''")}'`,
    '$dialog.ShowNewFolderButton = $true',
    // 对话框显示后再强制置前一次，避免被浏览器等窗口挡住
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 300',
    '$timer.Add_Tick({',
    '  try { [WxaDialog.Native]::SetForegroundWindow($dialog.Handle) | Out-Null } catch { }',
    '  $timer.Stop()',
    '})',
    '$timer.Start()',
    '$result = $dialog.ShowDialog($owner)',
    '$timer.Stop()',
    '$timer.Dispose()',
    'if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {',
    '  [System.IO.File]::WriteAllText($env:WXA_DIALOG_OUT, $dialog.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))',
    '}',
    '$owner.Close()',
  ].join('\r\n');
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn('powershell.exe', ['-STA', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, WXA_DIALOG_OUT: resultFile },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString().slice(0, 2000); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      fsp.rm(resultFile, { force: true }).catch(() => undefined);
      reject(new Error('文件夹选择超时，请重试'));
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法打开系统文件夹选择框：${error.message}`));
    });
    child.on('exit', async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const selected = (await fsp.readFile(resultFile, 'utf8').catch(() => '')).trim();
        await fsp.rm(resultFile, { force: true }).catch(() => undefined);
        if (selected) {
          resolve({ path: path.resolve(selected), cancelled: false });
        } else {
          resolve({ path: null, cancelled: true, code, stderr: stderr.trim().slice(0, 400) || undefined });
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function pickFolder(options = {}) {
  const run = () => showFolderDialog(options);
  const task = chain.then(run, run);
  chain = task.catch(() => undefined);
  return task;
}

/**
 * 在面板内浏览本机文件夹（系统对话框无法前置时的兜底方案）。
 * path 为空时列出所有盘符；否则列出该目录下的子目录。
 */
export async function listDirectories(rawPath = '') {
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = `${String.fromCharCode(code)}:\\`;
    try {
      const stat = await fsp.stat(letter);
      if (stat.isDirectory()) drives.push({ name: letter, path: letter });
    } catch { /* 盘符不存在 */ }
  }
  const value = String(rawPath || '').trim();
  if (!value) {
    return { path: '', parent: null, drives, entries: [] };
  }
  const resolved = path.resolve(value);
  const stat = await fsp.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`文件夹不存在或不可访问：${resolved}`);
  const entries = [];
  const children = await fsp.readdir(resolved, { withFileTypes: true }).catch(() => []);
  for (const child of children) {
    if (!child.isDirectory()) continue;
    if (child.name.startsWith('$') || child.name === 'System Volume Information') continue;
    const full = path.join(resolved, child.name);
    entries.push({ name: child.name, path: full });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent && parent !== resolved ? parent : null,
    drives,
    entries,
  };
}
