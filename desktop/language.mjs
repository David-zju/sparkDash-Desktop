export const LANGUAGE_KEY = 'sparkdash-language';
export const normalizeLanguage = (value) => value === 'zh-CN' ? 'zh-CN' : 'en';

/** Explicit labels keep Electron roles translated independently of the OS locale. */
export function applicationMenuTemplate({ language, platform, setLanguage, reconnect, openData, openLog }) {
  const t = (en, zh) => language === 'zh-CN' ? zh : en;
  const role = (name, en, zh) => ({ role: name, label: t(en, zh) });
  return [
    { label: 'sparkDash', submenu: [role('about', 'About sparkDash', '关于 sparkDash'), { type: 'separator' }, role('quit', 'Quit sparkDash', '退出 sparkDash')] },
    { label: t('Edit', '编辑'), submenu: [
      role('undo', 'Undo', '撤销'), role('redo', 'Redo', '重做'), { type: 'separator' },
      role('cut', 'Cut', '剪切'), role('copy', 'Copy', '复制'), role('paste', 'Paste', '粘贴'),
      role('selectAll', 'Select All', '全选'),
    ] },
    { label: t('Monitoring', '监控'), submenu: [
      { id: 'monitoring-reconnect', label: t('Reconnect backend', '重新连接后台'), click: reconnect },
      { label: t('Open data folder', '打开数据目录'), click: openData },
      { label: t('Open log', '打开日志'), click: openLog },
    ] },
    { label: '语言 / Language', submenu: [
      { id: 'language-zh-CN', label: '简体中文', type: 'radio', checked: language === 'zh-CN', click: () => setLanguage('zh-CN') },
      { id: 'language-en', label: 'English', type: 'radio', checked: language === 'en', click: () => setLanguage('en') },
    ] },
    { label: t('View', '显示'), submenu: [
      role('reload', 'Reload', '重新加载'), role('forceReload', 'Force Reload', '强制重新加载'),
      role('toggleDevTools', 'Toggle Developer Tools', '切换开发者工具'), { type: 'separator' },
      role('resetZoom', 'Actual Size', '实际大小'), role('zoomIn', 'Zoom In', '放大'), role('zoomOut', 'Zoom Out', '缩小'),
      { type: 'separator' }, role('togglefullscreen', 'Toggle Full Screen', '切换全屏'),
    ] },
    { label: t('Window', '窗口'), submenu: [
      role('minimize', 'Minimize', '最小化'), role('zoom', 'Zoom', '缩放'), role('close', 'Close', '关闭'),
      ...(platform === 'darwin' ? [{ type: 'separator' }, role('front', 'Bring All to Front', '前置全部窗口')] : []),
    ] },
  ];
}

const statusMessages = {
  credentials: ['Opening sparkDash secure storage', '正在打开 sparkDash 安全存储',
    'macOS may request access to “sparkDash Safe Storage”. It holds this app’s encryption key for SSH passwords and LLM API keys. Enter your Mac login keychain password only in the system dialog; the app never receives it. If denied, retry from Monitoring → Reconnect backend.',
    'macOS 可能请求访问“sparkDash Safe Storage”。它保存本应用的加密密钥，用来保护 SSH 密码和 LLM API Key。若系统询问密码，请仅在系统弹窗中输入 Mac 登录钥匙串密码；应用不会收到该密码。拒绝后可以从“监控”菜单重新连接后台并重试。'],
  starting: ['Starting sparkDash', '正在启动 sparkDash', 'Opening the local backend and saved device configuration.', '正在打开本机后台与已保存的设备配置。'],
  stopped: ['Backend stopped', '后台已停止', 'Sampling is paused. Choose Monitoring → Reconnect backend to retry. Previously running benchmarks will not restart automatically.', '采样已暂停。可从“监控”菜单选择“重新连接后台”。已运行的压测不会自动重试。'],
  failed: ['sparkDash could not start', 'sparkDash 暂时无法启动', 'Retry from the Monitoring menu, or open the log for details.', '可从“监控”菜单重试，或打开日志查看原因。'],
  suspended: ['Sampling paused', '采样已暂停', 'Devices will reconnect when your Mac wakes. No data is fabricated for the sleep period.', 'Mac 唤醒后会重新连接设备。休眠期间不会补造数据。'],
};

export function statusMessage(language, kind, detail = '') {
  const [enTitle, zhTitle, enText, zhText] = statusMessages[kind];
  const chinese = language === 'zh-CN';
  return { title: chinese ? zhTitle : enTitle, message: [detail, chinese ? zhText : enText].filter(Boolean).join(' ') };
}
