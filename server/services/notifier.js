import { spawn } from 'node:child_process';

/**
 * 本地通知兜底：Windows 使用 PowerShell NotifyIcon 气泡通知；
 * 文本通过环境变量传递，避免命令拼接/中文引号问题。非 Windows 或失败时静默返回 false。
 */
export async function showLocalNotification({ title = '视频号助手自动化工具', message = '' } = {}) {
  if (process.platform !== 'win32') return { shown: false, reason: '当前系统不支持 Windows 通知' };
  const text = String(message || '').trim();
  if (!text) return { shown: false, reason: '通知内容为空' };
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon = [System.Drawing.SystemIcons]::Information',
    '$n.Visible = $true',
    '$n.ShowBalloonTip(8000, $env:WXA_NOTICE_TITLE, $env:WXA_NOTICE_MESSAGE, [System.Windows.Forms.ToolTipIcon]::Warning)',
    'Start-Sleep -Seconds 9',
    '$n.Visible = $false',
    '$n.Dispose()',
  ].join('; ');
  return new Promise((resolve) => {
    try {
      const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
        env: { ...process.env, WXA_NOTICE_TITLE: title, WXA_NOTICE_MESSAGE: text },
        stdio: 'ignore',
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        resolve({ shown: false, reason: '本地通知超时' });
      }, 12_000);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ shown: false, reason: String(error?.message || error) });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ shown: code === 0, reason: code === 0 ? '' : `PowerShell 退出码 ${code}` });
      });
    } catch (error) {
      resolve({ shown: false, reason: String(error?.message || error) });
    }
  });
}
