package main

func consoleLog(args ...interface{}) {
	console.Call("log", args...)
}
