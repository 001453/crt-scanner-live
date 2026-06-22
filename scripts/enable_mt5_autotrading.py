"""MT5 — Algoritmik Ticaret'i ac (Windows). Once durumu okur, kapaliysa acar."""
import argparse
import ctypes
import glob
import os
import sys
import time
from ctypes import wintypes

WM_COMMAND = 0x0111
MT_WMCMD_EXPERTS = 32851
GA_ROOT = 2

EXPERTS_BLOCK = (
    '\n[Experts]\n'
    'AllowLiveTrading=1\n'
    'Enabled=1\n'
    'AllowDllImport=1\n'
    'Account=0\n'
    'Profile=0\n'
    'Chart=0\n'
)

BROKER_PROFILES = {
    'vantage': {
        'keywords': ['29535144', 'VantageMarkets', 'Vantage'],
        'ini': os.path.join(
            os.environ.get('APPDATA', ''),
            'MetaQuotes', 'Terminal', '725B72F25E46C780EF59F57016D58156', 'config', 'common.ini'
        ),
        'env_file': '.env.vantage',
    },
    'lotas': {
        'keywords': ['506185', 'Lotas', 'LotasCapital'],
        'ini': '',
        'env_file': '.env',
    },
}


def load_env_file(path):
    if not path or not os.path.isfile(path):
        return
    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith('#') or '=' not in s:
                continue
            key, val = s.split('=', 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def patch_common_ini(ini_path):
    if not ini_path or not os.path.isfile(ini_path):
        return False, f'ini_not_found:{ini_path or "-"}'
    with open(ini_path, 'r', encoding='utf-8', errors='ignore') as f:
        txt = f.read()
    if '[Experts]' in txt:
        return True, 'ini_already_has_experts'
    with open(ini_path, 'a', encoding='utf-8') as f:
        f.write(EXPERTS_BLOCK)
    return True, 'ini_patched'


def find_common_ini_by_keywords(keywords):
    root = os.path.join(os.environ.get('APPDATA', ''), 'MetaQuotes', 'Terminal')
    if not os.path.isdir(root):
        return ''
    keys = [k.lower().replace(' ', '') for k in keywords if k]
    for ini_path in glob.glob(os.path.join(root, '*', 'config', 'common.ini')):
        origin = os.path.join(os.path.dirname(ini_path), 'origin.txt')
        try:
            blob = ''
            if os.path.isfile(origin):
                with open(origin, 'r', encoding='utf-8', errors='ignore') as f:
                    blob += f.read()
            with open(ini_path, 'r', encoding='utf-8', errors='ignore') as f:
                blob += f.read()
            low = blob.lower().replace(' ', '')
            if any(k in low for k in keys):
                return ini_path
        except OSError:
            continue
    return ''


def find_mt5_hwnd(keywords):
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
        low = title.lower().replace(' ', '')
        if any(k in low or k in title for k in keywords):
            found.append(hwnd)
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found[0] if found else None


def toggle_algo_on(keywords):
    hwnd = find_mt5_hwnd(keywords)
    if not hwnd:
        return False, 'mt5_window_not_found'
    root = ctypes.windll.user32.GetAncestor(hwnd, GA_ROOT)
    ok = ctypes.windll.user32.PostMessageW(root, WM_COMMAND, MT_WMCMD_EXPERTS, 0)
    return bool(ok), f'posted_wm_command hwnd={hwnd} root={root}'


def mt5_trade_allowed():
    try:
        import MetaTrader5 as mt5
    except ImportError:
        return None, 'metatrader5_module_missing'
    path = str(os.environ.get('MT5_PATH', '') or '').strip()
    login = int(os.environ.get('MT5_LOGIN', '0') or 0)
    password = str(os.environ.get('MT5_PASSWORD', '') or '')
    server = str(os.environ.get('MT5_SERVER', '') or '').strip()
    if not path or not login or not password or not server:
        return None, 'mt5_env_incomplete'
    if not mt5.initialize(path, login=login, password=password, server=server):
        return None, f'mt5_initialize_failed:{mt5.last_error()}'
    t = mt5.terminal_info()
    allowed = bool(t and getattr(t, 'trade_allowed', False))
    mt5.shutdown()
    return allowed, 'ok'


def ensure_algo_trading(keywords, ini_path=''):
    patch_common_ini(ini_path or find_common_ini_by_keywords(keywords))
    before, st = mt5_trade_allowed()
    if before is True:
        return True, 'already_enabled'
    if before is None:
        post_ok, post_msg = toggle_algo_on(keywords)
        return post_ok, f'no_mt5_check:{st}:{post_msg}'
    post_ok, post_msg = toggle_algo_on(keywords)
    if not post_ok:
        return False, post_msg
    time.sleep(2.0)
    after, _ = mt5_trade_allowed()
    if after is True:
        return True, 'enabled_now'
    return False, f'still_disabled after_toggle:{post_msg}'


def main():
    parser = argparse.ArgumentParser(description='Enable MT5 algorithmic trading')
    parser.add_argument('--profile', choices=['vantage', 'lotas'], default='')
    parser.add_argument('--keywords', default='', help='Comma-separated window title keywords')
    parser.add_argument('--ini', default='', help='Optional common.ini path')
    args = parser.parse_args()

    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    profile = BROKER_PROFILES.get(str(args.profile or '').strip(), None)
    if profile:
        load_env_file(os.path.join(root, profile['env_file']))

    keywords = [k.strip() for k in str(args.keywords or '').split(',') if k.strip()]
    if not keywords and profile:
        keywords = list(profile['keywords'])
    if not keywords:
        keywords = ['506185', 'Lotas']

    ini_path = str(args.ini or '').strip()
    if not ini_path and profile:
        ini_path = profile.get('ini') or ''
    if not ini_path:
        ini_path = find_common_ini_by_keywords(keywords)

    ok, msg = ensure_algo_trading(keywords, ini_path)
    print(f'ok={ok} ({msg})')
    if not ok:
        sys.exit(1)


if __name__ == '__main__':
    main()
