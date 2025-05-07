// ==UserScript==
// @name         Overword
// @namespace    http://tampermonkey.net/
// @version      2025-05-07
// @description  try to take over the world!
// @author       You
// @match        http://*/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @require      https://github.com/PRO-2684/GM_config/releases/download/v1.2.1/config.min.js#md5=525526b8f0b6b8606cedf08c651163c2
// @require      https://cdn.jsdelivr.net/combine/npm/@violentmonkey/dom@2,npm/@violentmonkey/ui@0.7
// ==/UserScript==


(function() {
    'use strict';
    if (typeof GM_config !== 'undefined') {
        unsafeWindow.GM_config = GM_config;
    }
})();

// gopher.js


