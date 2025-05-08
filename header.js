// ==UserScript==
// @name         [Overword] - auto find words on page
// @namespace    http://tampermonkey.net/
// @version      2025-05-08
// @description  Небольшое расширение, которое осуществляет автоматический поиск слов на странице
// @author       afansv
// @match        https://*/*
// @match        http://*/*
// @icon         https://raw.githubusercontent.com/afansv/overword/master/images/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @homepageURL  https://github.com/afansv/overword
// @updateURL    https://raw.githubusercontent.com/afansv/overword/master/dist/overword.user.js
// @downloadURL  https://raw.githubusercontent.com/afansv/overword/master/dist/overword.user.js
// @supportURL   https://github.com/afansv/overword/issues
// @require      https://github.com/PRO-2684/GM_config/releases/download/v1.2.1/config.min.js#md5=525526b8f0b6b8606cedf08c651163c2
// ==/UserScript==

(function() {
    'use strict';
    if (typeof GM_config !== 'undefined') {
        unsafeWindow.GM_config = GM_config;
    }
})();

// gopher.js

