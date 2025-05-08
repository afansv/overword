package main

import "github.com/gopherjs/gopherjs/js"

var highlighter *Highlighter

var (
	body         *js.Object
	unsafeWindow *js.Object
	console      *js.Object
)

var (
	gmConfig *js.Object
)

func init() {
	body = js.Global.Get("document").Get("body")
	console = js.Global.Get("console")
	unsafeWindow = js.Global.Get("unsafeWindow")
	gmConfig = unsafeWindow.Get("GM_config")
}
