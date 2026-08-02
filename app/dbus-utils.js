/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2019-2025 Sergio Costas (rastersoft@gmail.com)
 * Based on code original (C) Carlos Soriano
 * Some code from Gtk4 DING version by (C) Sundeep Mediratta (smedius@gmail.com)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */
import 'gi://Gtk?version=4.0';
import 'gi://Gdk?version=4.0';
import 'gi://GdkWayland?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Signals from './signals.js';
import * as DBusInterfaces from './dbus-interfaces.js';
import * as DesktopIconsUtil from './desktop-icons-util.js';
import * as Enums from './enums.js';
import { RemoteFileOperationsManager,
    LegacyRemoteFileOperationsManager } from './dbus-remote-operations.js';

export var NautilusFileOperations2 = null;
export var FreeDesktopFileManager = null;
export var GnomeNautilusPreview = null;
export var SwitcherooControl = null;
export var GnomeArchiveManager = null;
export var GtkVfsMetadata = null;
export var extensionControl = null;

export var discreteGpuAvailable = false;
var dbusManagerObject;
export var RemoteFileOperations = null;

import Gettext from 'gettext';

const _ = Gettext.gettext;

export var ProxyManager = class {
    /*
    * This class manages a DBus object through a DBusProxy. Any access to the proxy when the
    * object isn't available results in a notification specifying that an specific program
    * is needed to run that option.
    *
    * The proxy itself is accessed through the 'proxy' property (read-only). Any access to
    * it will check the availability and show the notification if it isn't available. To get
    * access to it without triggering this, it is possible to use the 'proxyNoCheck' property.
    *
    * Whether the object is or not available can be checked with the 'isAvailable' property.
    * Also, every time the availability changes, the signal 'changed-status' is emitted.
    */
    constructor(dbusManager, serviceName, objectName, interfaceName, inSystemBus, programNeeded) {
        this._dbusManager = dbusManager;
        this._serviceName = serviceName;
        this._objectName = objectName;
        this._interfaceName = interfaceName;
        this._inSystemBus = inSystemBus;
        this._signals = {};
        this._signalsIDs = {};
        this._connectSignals = {};
        this._connectSignalsIDs = {};
        this._beingLaunched = false;
        if (typeof programNeeded == 'string') {
            // if 'programNeeded' is a string, create a generic message for the notification.
            this._programNeeded = [
                _('"${programName}" is needed for Desktop Icons').replace('${programName}', programNeeded),
                _('For this functionality to work in Desktop Icons, you must install "${programName}" in your system.').replace('${programName}', programNeeded),
                programNeeded,
            ];
        } else {
            // instead, if it's not, it is presumed to be an array with two sentences, one for the notification title and another for the main text.
            this._programNeeded = programNeeded;
        }
        this._timeout = 0;
        this._available = false;
        this._proxy = null;
        if (this._dbusManager.checkIsAvailable(this._serviceName, this._inSystemBus)) {
            this.makeNewProxy();
        }
        dbusManager.connect(inSystemBus ? 'changed-availability-system' : 'changed-availability-local', () => {
            const newAvailability = this._dbusManager.checkIsAvailable(this._serviceName, this._inSystemBus);
            if (newAvailability != this._available) {
                if (newAvailability) {
                    this.makeNewProxy();
                } else {
                    this._available = false;
                    this._proxy = null;
                    this.emit('changed-status', false);
                }
            }
        });
    }

    connectSignalToProxy(signal, cb) {
        this._connectSignals[signal] = cb;
        if (this._proxy) {
            this._connectSignalsIDs[signal] = this._proxy.connectSignal(signal, cb);
        }
    }

    connectToProxy(signal, cb) {
        this._signals[signal] = cb;
        if (this._proxy) {
            this._signalsIDs[signal] = this._proxy.connect(signal, cb);
        }
    }

    disconnectFromProxy(signal) {
        if (signal in this._signalsIDs) {
            if (this._proxy) {
                this._proxy.disconnect(this._signalsIDs[signal]);
            }
            delete this._signalsIDs[signal];
        }
    }

    disconnectSignalFromProxy(signal) {
        if (signal in this._connectSignalsIDs) {
            if (this._proxy) {
                this._proxy.disconnectSignal(this._connectSignalsIDs[signal]);
            }
            delete this._connectSignalsIDs[signal];
        }
    }

    async makeNewProxy(delay = 0) {
        if (delay !== 0) {
            await DesktopIconsUtil.waitDelayMs(delay);
            if (!this._dbusManager.checkIsAvailable(this._serviceName, this._inSystemBus)) {
                return;
            }
        }
        if (this._beingLaunched) {
            return;
        }
        this._interfaceXML = this._dbusManager.getInterface(this._serviceName, this._objectName, this._interfaceName, this._inSystemBus, false);
        if (this._interfaceXML) {
            this._beingLaunched = true;
            try {
                new Gio.DBusProxy.makeProxyWrapper(this._interfaceXML)(
                    this._inSystemBus ? Gio.DBus.system : Gio.DBus.session,
                    this._serviceName,
                    this._objectName,
                    (proxy, error) => {
                        this._beingLaunched = false;
                        if (error === null) {
                            // The service restarted: disconnect handlers from the
                            // previous proxy before wiring the new one.
                            for (let signal in this._signalsIDs) {
                                if (this._proxy) {
                                    this._proxy.disconnect(this._signalsIDs[signal]);
                                }
                                delete this._signalsIDs[signal];
                            }
                            for (let signal in this._connectSignalsIDs) {
                                if (this._proxy) {
                                    this._proxy.disconnectSignal(this._connectSignalsIDs[signal]);
                                }
                                delete this._connectSignalsIDs[signal];
                            }
                            for (let signal in this._signals) {
                                this._signalsIDs[signal] = proxy.connect(signal, this._signals[signal]);
                            }
                            for (let signal in this._connectSignals) {
                                this._connectSignalsIDs[signal] = proxy.connectSignal(signal, this._connectSignals[signal]);
                            }
                            this._available = true;
                            this._proxy = proxy;
                            print(`DBus interface for ${this._programNeeded[2]} (${this._interfaceName}) is now available.`);
                            this.emit('changed-status', true);
                        } else {
                            console.error(error, `Error creating proxy, ${this._programNeeded[2]} (${this._interfaceName}); relaunching.\n`);
                            this.makeNewProxy(1000);
                        }
                    }
                );
            } catch (e) {
                console.error(e, `Error creating proxy, ${this._programNeeded[0]}`);
                this._beingLaunched = false;
                this.makeNewProxy(1000);
            }
        }
    }

    get isAvailable() {
        return this._available;
    }

    get proxyNoCheck() {
        return this._proxy;
    }

    get proxy() {
        if (!this._available) {
            if (this._programNeeded && (this._timeout == 0)) {
                print(this._programNeeded[0]);
                print(this._programNeeded[1]);
                this._dbusManager.doNotify(this._programNeeded[0], this._programNeeded[1]);
                this._timeout = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    1000,
                    () => {
                        this._timeout = 0;
                        return false;
                    }
                );
            }
        }
        return this._proxy;
    }
}
Signals.addSignalMethods(ProxyManager.prototype);


export var DBusManager = class {
    /*
    * This class manages all the DBus operations. A ProxyManager() class can subscribe to this to be notified
    * whenever a change in the bus has occurred (like a server has been added or removed). It also can ask
    * for a DBus interface, either getting it from the dbusInterfaces.js file or using DBus Introspection (which
    * allows to get the currently available interface and, that way, know if an object implements an specific
    * method, property or signal).
    *
    * ProxyManager() classes subscribe to the 'changed-availability-system' or 'changed-availability-local' signals,
    * which are emitted every time a change in the bus or in the configuration files happen. Then, it can use
    * checkIsAvailable() to determine if the desired service is available in the system or not.
    */
    constructor() {
        this._availableInSystemBus = [];
        this._availableInLocalBus = [];
        this._pendingLocalSignal = false;
        this._pendingSystemSignal = false;
        this._signalTimerID = 0;

        let interfaceXML = this.getInterface(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            Enums.DBusBus.SYSTEM, // system bus
            true); // use DBus Introspection
        this._dbusSystemProxy = new Gio.DBusProxy.makeProxyWrapper(interfaceXML)(
            Gio.DBus.system,
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            null
        );
        let ASCinSystemBus = interfaceXML.includes('ActivatableServicesChanged');

        // Don't presume that both system and local have the same interface (just in case)
        interfaceXML = this.getInterface(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            Enums.DBusBus.SESSION,
            true); // use DBus Introspection
        this._dbusLocalProxy = new Gio.DBusProxy.makeProxyWrapper(interfaceXML)(
            Gio.DBus.session,
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            null
        );
        let ASCinLocalBus = interfaceXML.includes('ActivatableServicesChanged');

        this._updateAllAvailabilities();
        this._dbusLocalProxy.connectSignal('NameOwnerChanged', () => {
            this._emitChangedSignal(true);
        });
        if (ASCinLocalBus) {
            this._dbusLocalProxy.connectSignal('ActivatableServicesChanged', () => {
                this._emitChangedSignal(true);
            });
        }
        this._dbusSystemProxy.connectSignal('NameOwnerChanged', () => {
            this._emitChangedSignal(false);
        });
        if (ASCinSystemBus) {
            this._dbusSystemProxy.connectSignal('ActivatableServicesChanged', () => {
                this._emitChangedSignal(false);
            });
        }

        interfaceXML = this.getInterface(
            'org.freedesktop.Notifications',
            '/org/freedesktop/Notifications',
            'org.freedesktop.Notifications',
            Enums.DBusBus.SESSION,
            false); // get interface from local code
        this._notifyProxy = new Gio.DBusProxy.makeProxyWrapper(interfaceXML)(
            Gio.DBus.session,
            'org.freedesktop.Notifications',
            '/org/freedesktop/Notifications',
            null
        );
    }

    _emitChangedSignal(localDBus) {
        if (localDBus) {
            this._pendingLocalSignal = true;
        } else {
            this._pendingSystemSignal = true;
        }
        if (this._signalTimerID) {
            GLib.source_remove(this._signalTimerID);
        }
        this._signalTimerID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._signalTimerID = 0;
            this._updateAllAvailabilities();
            if (this._pendingLocalSignal) {
                this.emit('changed-availability-local');
            }
            if (this._pendingSystemSignal) {
                this.emit('changed-availability-system');
            }
            this._pendingLocalSignal = false;
            this._pendingSystemSignal = false;
            return false;
        });
    }

    checkIsAvailable(serviceName, inSystemBus) {
        if (inSystemBus) {
            return this._availableInSystemBus.includes(serviceName);
        } else {
            return this._availableInLocalBus.includes(serviceName);
        }
    }

    _updateAllAvailabilities() {
        this._availableInLocalBus = this._updateAvailability(this._dbusLocalProxy);
        this._availableInSystemBus = this._updateAvailability(this._dbusSystemProxy);
    }

    _updateAvailability(proxy) {
        // We read both the well-known names actually running and those available as activatables,
        // and generate a single list with both. Thus a service will be "enabled" if it is running
        // or if it is activatable.

        let availableNames = [];
        let names = proxy.ListNamesSync();
        for (let n of names[0]) {
            if (n.startsWith(':')) {
                continue;
            }
            if (!availableNames.includes(n)) {
                availableNames.push(n);
            }
        }
        let names2 = proxy.ListActivatableNamesSync();
        for (let n of names2[0]) {
            if (n.startsWith(':')) {
                continue;
            }
            if (!availableNames.includes(n)) {
                availableNames.push(n);
            }
        }
        return availableNames;
    }

    _getNextTag() {
        this._xmlIndex++;
        let pos = this._xmlData.indexOf('<', this._xmlIndex);
        if (pos == -1) {
            return null;
        }
        let pos2 = this._xmlData.indexOf('>', pos);
        if (pos2 == -1) {
            return null;
        }
        this._xmlIndex = pos;
        return this._xmlData.substring(pos + 1, pos2).trim();
    }

    /*
     * Extracts the XML definition for an interface from the raw data returned by DBus Introspection.
     * This is needed because DBus Introspection returns a single XML file with all the interfaces
     * supported by an object, while DBusProxyWrapper requires an XML with only the desired interface.
     */
    _parseXML(data, interfaceName) {
        this._xmlIndex = -1;
        this._xmlData = data;
        let tag;
        while (true) {
            tag = this._getNextTag();
            if (tag === null) {
                return null;
            }
            if (!tag.startsWith('interface ')) {
                continue;
            }
            if (tag.includes(interfaceName)) {
                break;
            }
        }
        let start = this._xmlIndex;
        while (true) {
            tag = this._getNextTag();
            if (tag === null) {
                return null;
            }
            if (!tag.startsWith('/interface')) {
                continue;
            }
            break;
        }
        return `<node>\n  ${data.substring(start, 1 + data.indexOf('>', this._xmlIndex))}\n</node>`;
    }

    getInterface(serviceName, objectName, interfaceName, inSystemBus, forceIntrospection) {
        if ((interfaceName in DBusInterfaces.DBusInterfaces) && !forceIntrospection) {
            return DBusInterfaces.DBusInterfaces[interfaceName];
        } else {
            let data = this.getIntrospectionData(serviceName, objectName, inSystemBus);
            if (data == null) {
                return null;
            } else {
                return this._parseXML(data, interfaceName);
            }
        }
    }

    getIntrospectionData(serviceName, objectName, inSystemBus) {
        let data = null;
        try {
            let wraper = new Gio.DBusProxy.makeProxyWrapper(DBusInterfaces.DBusInterfaces['org.freedesktop.DBus.Introspectable'])(
                inSystemBus ? Gio.DBus.system : Gio.DBus.session,
                serviceName,
                objectName,
                null
            );
            data = wraper.IntrospectSync()[0];
        } catch (e) {
            console.error(e, 'Error getting introspection data over Dbus.');
        }
        if (data == null) {
            return null;
        }
        if (!data.includes('interface')) {
            return null; // if it doesn't exist, return null
        }
        return data;
    }

    doNotify(header, text) {
        /*
         * The notification interface in GLib.Application requires a .desktop file, which
         * we can't have, so we must use directly the Notification DBus interface
         */
        this._notifyProxy.NotifyRemote('Desktop Icons', 0, '', header, text, [], {}, -1, () => {});
    }
}
Signals.addSignalMethods(DBusManager.prototype);


export function init(mainApp) {
    dbusManagerObject = new DBusManager();

    let data = dbusManagerObject.getIntrospectionData(
        'org.gnome.Nautilus',
        '/org/gnome/Nautilus/FileOperations2',
        Enums.DBusBus.SESSION);

    if (data) {
        // NautilusFileOperations2
        NautilusFileOperations2 = new ProxyManager(
            dbusManagerObject,
            'org.gnome.Nautilus',
            '/org/gnome/Nautilus/FileOperations2',
            'org.gnome.Nautilus.FileOperations2',
            Enums.DBusBus.SESSION,
            'Nautilus'
        );
    } else {
        print('Emulating NautilusFileOperations2 with the old NautilusFileOperations interface');
        // Emulate NautilusFileOperations2 with the old interface
        NautilusFileOperations2 = new ProxyManager(
            dbusManagerObject,
            'org.gnome.Nautilus',
            '/org/gnome/Nautilus',
            'org.gnome.Nautilus.FileOperations',
            Enums.DBusBus.SESSION,
            'Nautilus'
        );
    }

    FreeDesktopFileManager = new ProxyManager(
        dbusManagerObject,
        'org.freedesktop.FileManager1',
        '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1',
        Enums.DBusBus.SESSION,
        'Nautilus'
    );

    GnomeNautilusPreview = new ProxyManager(
        dbusManagerObject,
        'org.gnome.NautilusPreviewer',
        '/org/gnome/NautilusPreviewer',
        'org.gnome.NautilusPreviewer',
        Enums.DBusBus.SESSION,
        'Nautilus-Sushi'
    );

    GnomeArchiveManager = new ProxyManager(
        dbusManagerObject,
        'org.gnome.ArchiveManager1',
        '/org/gnome/ArchiveManager1',
        'org.gnome.ArchiveManager1',
        Enums.DBusBus.SESSION,
        'File-roller'
    );

    GtkVfsMetadata = new ProxyManager(
        dbusManagerObject,
        'org.gtk.vfs.Metadata',
        '/org/gtk/vfs/metadata',
        'org.gtk.vfs.Metadata',
        Enums.DBusBus.SESSION,
        'Gvfs daemon'
    );

    SwitcherooControl = new ProxyManager(
        dbusManagerObject,
        'net.hadess.SwitcherooControl',
        '/net/hadess/SwitcherooControl',
        'net.hadess.SwitcherooControl',
        Enums.DBusBus.SYSTEM,
        'Switcheroo control'
    );
    discreteGpuAvailable = SwitcherooControl.isAvailable;
    SwitcherooControl.connect('changed-status', (obj, newStatus) => {
        discreteGpuAvailable = newStatus;
    });

    if (data) {
        RemoteFileOperations = new RemoteFileOperationsManager(mainApp, NautilusFileOperations2, FreeDesktopFileManager, GnomeNautilusPreview, GnomeArchiveManager);
    } else {
        RemoteFileOperations = new LegacyRemoteFileOperationsManager(NautilusFileOperations2, FreeDesktopFileManager, GnomeNautilusPreview, GnomeArchiveManager);
    }

    extensionControl = Gio.DBusActionGroup.get(
        Gio.DBus.session,
        'com.rastersoft.dingextension',
        '/com/rastersoft/dingextension/control'
    );

    return dbusManagerObject;
}
