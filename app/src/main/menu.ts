import type { MenuItemConstructorOptions } from 'electron';
import { t } from '../shared/i18n.mjs';

export function applicationMenu(): MenuItemConstructorOptions[] {
  // Retain the standard macOS roles from Electron 43 while owning their labels.
  const item = (role: MenuItemConstructorOptions['role'], key: string): MenuItemConstructorOptions => ({ role, label: t(key) });
  return [
    { role: 'appMenu', label: t('appName'), submenu: [item('about', 'menuAbout'), { type: 'separator' }, item('services', 'menuServices'), { type: 'separator' }, item('hide', 'menuHide'), item('hideOthers', 'menuHideOthers'), item('unhide', 'menuShowAll'), { type: 'separator' }, item('quit', 'menuQuit')] },
    { role: 'editMenu', label: t('menuEdit'), submenu: [
      item('undo', 'menuUndo'), item('redo', 'menuRedo'), { type: 'separator' }, item('cut', 'menuCut'), item('copy', 'copy'), item('paste', 'menuPaste'),
      item('pasteAndMatchStyle', 'menuPasteMatch'), item('delete', 'menuDelete'), item('selectAll', 'menuSelectAll'), { type: 'separator' },
      { label: t('menuSubstitutions'), submenu: [item('showSubstitutions', 'menuShowSubstitutions'), { type: 'separator' }, item('toggleSmartQuotes', 'menuSmartQuotes'), item('toggleSmartDashes', 'menuSmartDashes'), item('toggleTextReplacement', 'menuTextReplacement')] },
      { label: t('menuSpeech'), submenu: [item('startSpeaking', 'menuStartSpeaking'), item('stopSpeaking', 'menuStopSpeaking')] }
    ] },
    { role: 'windowMenu', label: t('menuWindow'), submenu: [item('minimize', 'menuMinimize'), item('zoom', 'menuZoom'), { type: 'separator' }, item('front', 'menuFront')] }
  ];
}
