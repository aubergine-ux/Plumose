/*
 * Silent typing. Every chat in Osmium is a Conversation object, and the
 * composer reports typing through its setTyping(typing, action) method, which
 * sends a chats.SetTyping request. The method lives on the class, so wrapping
 * it once on the prototype covers every chat, including ones opened later.
 *
 * "Started typing" is dropped. "Stopped typing" only goes out if a "started"
 * got through before the plugin was switched on, so nobody is left looking at
 * a stuck indicator. Incoming typing events are untouched.
 */
PlumoseCore.definePlugin('silentTyping', (api) => {
    'use strict';

    let patched = null; // { proto, original }

    /** The Conversation class's prototype, reached through any chat the app has loaded. */
    function conversationProto() {
        const map = api.client()?.conversations?.conversations;
        if (!map || typeof map.values !== 'function') return null;
        for (const c of map.values()) {
            for (let proto = Object.getPrototypeOf(c); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
                if (Object.hasOwn(proto, 'setTyping') && typeof proto.setTyping === 'function') return proto;
            }
        }
        return null;
    }

    function patch() {
        if (patched) return true;
        const proto = conversationProto();
        if (!proto) return false;
        const original = proto.setTyping;
        proto.setTyping = function setTyping(typing = true, ...rest) {
            if (typing || !this.lastTypingStatus) return Promise.resolve();
            return original.call(this, typing, ...rest);
        };
        patched = { proto, original };
        return true;
    }

    return {
        start() {
            // No chat exists until the app has signed in and loaded its first conversation.
            if (patch()) return;
            const timer = setInterval(() => patch() && clearInterval(timer), 1000);
            api.track(() => clearInterval(timer));
        },
        stop() {
            if (patched) patched.proto.setTyping = patched.original;
            patched = null;
        },
    };
});
