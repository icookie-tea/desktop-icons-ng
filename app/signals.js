/* Minimal GJS-compatible signals implementation.
 *
 * GJS's built-in `signals` module is not importable from ES modules on
 * gjs 1.88, so this project-local copy provides the same semantics
 * (addSignalMethods / emit / connect / connect_after / disconnect /
 * disconnectAll). Based on the GJS signals.js design (MIT).
 */

function _getSignals(that) {
    if (that._signals === undefined) {
        that._signals = {};
    }
    return that._signals;
}

let _handlerIdCounter = 1;

function _connect(that, name, callback, after) {
    const signals = _getSignals(that);
    if (signals[name] === undefined) {
        signals[name] = [];
    }
    const handlerId = _handlerIdCounter++;
    signals[name].push([handlerId, after, callback]);
    return handlerId;
}

function _emit(that, name, args) {
    if (!that._signals || that._signals[name] === undefined) {
        return;
    }
    const handlers = that._signals[name];
    // "before" handlers first, then "after" handlers, in connection order.
    for (const after of [false, true]) {
        for (const [handlerId, isAfter, callback] of handlers) {
            if (isAfter !== after) {
                continue;
            }
            try {
                callback.apply(that, args);
            } catch (e) {
                logError(e, `Error while emitting signal "${name}" (handler ${handlerId})`);
            }
        }
    }
}

function _disconnect(that, name, id) {
    if (!that._signals || that._signals[name] === undefined) {
        return;
    }
    const handlers = that._signals[name];
    for (let i = 0; i < handlers.length; i++) {
        if (handlers[i][0] === id) {
            handlers.splice(i, 1);
            return;
        }
    }
}

export function addSignalMethods(proto) {
    proto.connect = function (name, callback) {
        return _connect(this, name, callback, false);
    };
    proto.connect_after = function (name, callback) {
        return _connect(this, name, callback, true);
    };
    proto.emit = function (name, ...args) {
        _emit(this, name, args);
    };
    proto.disconnect = function (id) {
        if (!this._signals) {
            return;
        }
        for (const name of Object.keys(this._signals)) {
            _disconnect(this, name, id);
        }
    };
    proto.disconnectAll = function () {
        this._signals = undefined;
    };
}
