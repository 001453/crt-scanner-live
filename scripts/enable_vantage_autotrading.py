"""Vantage MT5 — Algoritmik Ticaret dugmesini programatik ac (Windows)."""
import ctypes
import os
import sys
from ctypes import wintypes

WM_COMMAND = 0x0111
MT_WMCMD_EXPERTS = 32851
VANTAGE_COMMON_INI = os.path.join(
    os.environ.get('APPDATA', ''),
    'MetaQuotes', 'Terminal', '725B72F25E46C780EF59F57016D58156', 'config', 'common.ini'
)


def patch_common_ini():
    if not os.path.isfile(VANTAGE_COMMON_INI):
        return False, f'ini_not_found:{VANTAGE_COMMON_INI}'
    with open(VANTAGE_COMMON_INI, 'r', encoding='utf-8', errors='ignore') as f:
        txt = f.read()
    block = (
        '\n[Experts]\n'
        'AllowLiveTrading=1\n'
        'Enabled=1\n'
        'AllowDllImport=1\n'
        'Account=0\n'
        'Profile=0\n'
        'Chart=0\n'
    )
    if '[Experts]' in txt:
        return True, 'ini_already_has_experts'
    with open(VANTAGE_COMMON_INI, 'a', encoding='utf-8') as f:
        f.write(block)
    return True, 'ini_patched'


def find_vantage_hwnd():
    user32 = ctypes.windll.user32
    found = []

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        title = buf.value or ''
        low = title.lower()
        if ('vantagemarkets' in low.replace(' ', '')) or ('vantage markets' in low) or ('29535144' in title):
            found.append(hwnd)
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found[0] if found else None


def toggle_algo_trading():
    hwnd = find_vantage_hwnd()
    if not hwnd:
        return False, 'vantage_window_not_found'
    ok = ctypes.windll.user32.PostMessageW(hwnd, WM_COMMAND, MT_WMCMD_EXPERTS, 0)
    return bool(ok), f'posted_wm_command hwnd={hwnd}'


def main():
    ini_ok, ini_msg = patch_common_ini()
    post_ok, post_msg = toggle_algo_trading()
    print(f'ini={ini_ok} ({ini_msg})')
    print(f'post={post_ok} ({post_msg})')
    if not post_ok:
        sys.exit(1)


if __name__ == '__main__':
    main()
