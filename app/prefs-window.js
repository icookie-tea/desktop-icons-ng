import Adw from 'gi://Adw';
import Gettext from 'gettext';
import Gio from 'gi://Gio';
const GioSSS = Gio.SettingsSchemaSource;
import GLib from 'gi://GLib';

export var _ = Gettext.domain('ding').gettext;

var Gtk;

/**
 *
 * @param path
 * @param schema
 */
export function get_schema(path, schema) {
    // check if this extension was built with "make zip-file", and thus
    // has the schema files in a subfolder
    // otherwise assume that extension has been installed in the
    // same prefix as gnome-shell (and therefore schemas are available
    // in the standard folders)
    let schemaSource;
    let schemaFile = Gio.File.new_for_path(GLib.build_filenamev([path, 'schemas', 'gschemas.compiled']));
    if (schemaFile.query_exists(null)) {
        schemaSource = GioSSS.new_from_directory(GLib.build_filenamev([path, 'schemas']), GioSSS.get_default(), false);
    } else {
        schemaFile = Gio.File.new_for_path(GLib.build_filenamev([path, '..', 'schemas', 'gschemas.compiled']));
        if (schemaFile.query_exists(null)) {
            schemaSource = GioSSS.new_from_directory(GLib.build_filenamev([path, '..', 'schemas']), GioSSS.get_default(), false);
        } else {
            schemaSource = GioSSS.get_default();
        }
    }
    let schemaObj = schemaSource.lookup(schema, true);
    if (!schemaObj) {
        throw new Error(`Schema ${schema} could not be found for extension ` + '. Please check your installation.');
    }

    return new Gio.Settings({ settings_schema: schemaObj });
}

/**
 *
 * @param _Gtk
 * @param desktopSettings
 * @param nautilusSettings
 * @param gtkSettings
 */
export function preferencesFrame(_Gtk, desktopSettings, nautilusSettings, gtkSettings) {
    Gtk = _Gtk;
    let page = new Adw.PreferencesPage();

    // --- Desktop icons group ---
    let desktopGroup = new Adw.PreferencesGroup({
        title: _('Desktop icons'),
    });
    desktopGroup.add(buildSelector(desktopSettings, 'icon-size', _('Size for the desktop icons'), {
        'tiny': _('Tiny'), 'small': _('Small'), 'standard': _('Standard'), 'large': _('Large'),
    }, _('Set the size for the desktop icons')));
    desktopGroup.add(buildSelector(desktopSettings, 'start-corner', _('New icons alignment'), {
        'top-left': _('Top-left corner'),
        'top-right': _('Top-right corner'),
        'bottom-left': _('Bottom-left corner'),
        'bottom-right': _('Bottom-right corner'),
    }, _('Set the corner from where the icons will start to be placed')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'show-home', _('Show the personal folder in the desktop'), _('Show the personal folder in the desktop')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'show-trash', _('Show the trash icon in the desktop'), _('Show the trash icon in the desktop')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'show-volumes', _('Show external drives in the desktop'), _('Show the disk drives connected to the computer')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'show-network-volumes', _('Show network drives in the desktop'), _('Show mounted network volumes in the desktop')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'add-volumes-opposite', _('Add new drives to the opposite side of the screen'), _('When adding drives and volumes to the desktop, add them to the opposite side of the screen')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'show-drop-place', _("Highlight the drop place during Drag'n'Drop"), _('Shows a rectangle in the destination place during DnD')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'use-nemo', _('Use Nemo to open folders'), _('Use Nemo instead of Nautilus to open folders')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'show-link-emblem', _('Add an emblem to soft links'), _('Add an emblem to allow to identify soft links')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'dark-text-in-labels', _('Use dark text in icon labels'), _('Use black for label text')));
    page.add(desktopGroup);

    // --- Nautilus-shared settings group ---
    let nautilusGroup = new Adw.PreferencesGroup({
        title: _('Settings shared with Nautilus'),
    });
    nautilusGroup.add(buildSelector(nautilusSettings, 'click-policy', _('Click type for open files'), {
        'single': _('Single click'), 'double': _('Double click'),
    }, _('How to open files with the mouse')));
    nautilusGroup.add(buildSwitcher(gtkSettings, 'show-hidden', _('Show hidden files'), _('Show hidden files in the desktop')));
    nautilusGroup.add(buildSwitcher(nautilusSettings, 'show-delete-permanently', _('Show a context menu item to delete permanently'), _('Show a context menu item to delete permanently')));
    // Gnome Shell 40 removed this option
    try {
        nautilusGroup.add(buildSelector(nautilusSettings,
            'executable-text-activation',
            _('Action to do when launching a program from the desktop'), {
            'display': _('Display the content of the file'),
            'launch': _('Launch the file'),
            'ask': _('Ask what to do'),
        }, _('What to do when launching a program from the desktop')));
    } catch (e) {
    }
    nautilusGroup.add(buildSelector(nautilusSettings,
        'show-image-thumbnails',
        _('Show image thumbnails'), {
        'never': _('Never'),
        'local-only': _('Local files only'),
        'always': _('Always'),
    }, _('When to show thumbnails for image files')));
    page.add(nautilusGroup);

    return page;
}

/**
 *
 * @param settings
 * @param key
 * @param labelText
 * @param subtitleText
 */
export function buildSwitcher(settings, key, labelText, subtitleText = null) {
    let row = new Adw.SwitchRow({
        title: labelText,
        subtitle: subtitleText,
    });
    if (settings) {
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    } else {
        row.sensitive = false;
    }
    return row;
}

/**
 *
 * @param settings
 * @param key
 * @param labelText
 * @param elements
 * @param subtitleText
 */
export function buildSelector(settings, key, labelText, elements, subtitleText = null) {
    let values = [];
    let visibleTexts = [];
    if (settings) {
        let schemaKey = settings.settings_schema.get_key(key);
        values = schemaKey.get_range().get_child_value(1).get_child_value(0).get_strv();
        for (let val of values) {
            let visibleText = val;
            if (visibleText in elements) {
                visibleText = elements[visibleText];
            }
            visibleTexts.push(visibleText);
        }
    }
    // AdwComboRow renders GtkStringList items as labels automatically
    // (no expression needed). `selected` is an index into the list, so
    // map back and forth through the schema's value list.
    let stringList = new Gtk.StringList({ strings: visibleTexts });
    let comboRow = new Adw.ComboRow({
        title: labelText,
        subtitle: subtitleText,
        model: stringList,
    });
    if (settings) {
        comboRow.selected = Math.max(0, values.indexOf(settings.get_string(key)));
        comboRow.connect('notify::selected', () => {
            settings.set_string(key, values[comboRow.selected]);
        });
    } else {
        comboRow.sensitive = false;
    }
    return comboRow;
}
