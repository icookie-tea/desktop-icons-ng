project('ding',
  version: '50',
  license: 'GPL3'
)

gnome = import ('gnome')
i18n = import('i18n')

prefix = get_option('prefix')
datadir = join_paths (prefix, get_option('datadir'))
schema_dir = join_paths(datadir, 'glib-2.0', 'schemas')

extensions_dir = join_paths(prefix, 'share', 'gnome-shell', 'extensions', 'ding@rastersoft.com')

install_data([
    'emulateX11WindowType.js',
    'extension.js',
    'gnomeShellOverride.js',
    'metadata.json',
    'prefs.js',
    'visibleArea.js'
  ],
  install_dir: extensions_dir
)

subdir(
  'app'
)
subdir(
  'po'
)
subdir(
  'schemas'
)
subdir(
  'apparmor'
)

meson.add_install_script('meson_post_install.py')
