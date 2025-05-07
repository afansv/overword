package main

import (
	"sort"
	"strings"

	"github.com/gopherjs/gopherjs/js"
)

type Config struct {
	Words          []string
	HighlightClass string
	DebounceTime   int
}

type Highlighter struct {
	config     Config
	observer   *js.Object
	debounceID *js.Object
}

var highlighter *Highlighter

func main() {
	js.Global.Set("initHighlighter", initHighlighter)
	js.Global.Set("stopHighlighter", stopHighlighter)
	js.Global.Call("initHighlighter") // запуск по умолчанию
}

func initHighlighter(wordsObj *js.Object) {
	var words []string
	if wordsObj != nil && wordsObj != js.Undefined {
		for i := 0; i < wordsObj.Length(); i++ {
			word := wordsObj.Index(i).String()
			if word != "" {
				words = append(words, word)
			}
		}
	}
	if len(words) == 0 {
		words = []string{"важно", "срочно", "внимание"}
	}

	config := Config{
		Words:          words,
		HighlightClass: "highlightClass",
		DebounceTime:   1000,
	}

	highlighter = &Highlighter{config: config}
	addDefaultCSS(config.HighlightClass)
	highlighter.searchAndHighlight(js.Global.Get("document").Get("body"))
	highlighter.observeDOMChanges()
}

func (h *Highlighter) observeDOMChanges() {
	cb := js.MakeFunc(func(this *js.Object, args []*js.Object) interface{} {
		h.debounceHighlight()
		return nil
	})
	h.observer = js.Global.Get("MutationObserver").New(cb)
	h.observer.Call("observe", js.Global.Get("document").Get("body"), map[string]interface{}{
		"childList":     true,
		"subtree":       true,
		"characterData": true,
	})
}

func (h *Highlighter) debounceHighlight() {
	if h.debounceID != nil {
		js.Global.Get("clearTimeout").Invoke(h.debounceID)
	}
	h.debounceID = js.Global.Get("setTimeout").Invoke(func() {
		h.searchAndHighlight(js.Global.Get("document").Get("body"))
	}, h.config.DebounceTime)
}

func (h *Highlighter) collectTextNodes(node *js.Object, result *[]*js.Object) {
	nodeType := node.Get("nodeType").Int()
	if nodeType == 3 {
		*result = append(*result, node)
		return
	}

	// Пропускаем теги
	tag := strings.ToLower(node.Get("nodeName").String())
	if tag == "script" || tag == "style" || tag == "noscript" || tag == "iframe" {
		return
	}

	if node.Get("classList") != js.Undefined && node.Get("classList").Call("contains", h.config.HighlightClass).Bool() {
		return
	}

	children := node.Get("childNodes")
	for i := 0; i < children.Length(); i++ {
		child := children.Index(i)
		h.collectTextNodes(child, result)
	}
}

func (h *Highlighter) searchAndHighlight(root *js.Object) {
	var textNodes []*js.Object
	h.collectTextNodes(root, &textNodes)

	for _, node := range textNodes {
		h.highlightTextNode(node)
	}
}

func (h *Highlighter) highlightTextNode(textNode *js.Object) {
	text := textNode.Get("nodeValue").String()
	if text == "" {
		return
	}

	type Match struct {
		Start int
		End   int
		Word  string
	}
	var matches []Match
	lowerText := strings.ToLower(text)

	for _, word := range h.config.Words {
		word = strings.TrimSpace(word)
		if word == "" {
			continue
		}
		wordLower := strings.ToLower(word)
		idx := 0
		for {
			pos := strings.Index(lowerText[idx:], wordLower)
			if pos == -1 {
				break
			}
			start := idx + pos
			end := start + len(word)
			matches = append(matches, Match{Start: start, End: end, Word: text[start:end]})
			idx = end
		}
	}

	if len(matches) == 0 {
		return
	}

	sort.Slice(matches, func(i, j int) bool {
		return matches[i].Start < matches[j].Start
	})

	// Объединение перекрывающихся подсветок
	var merged []Match
	for _, m := range matches {
		if len(merged) == 0 || m.Start >= merged[len(merged)-1].End {
			merged = append(merged, m)
		} else {
			last := &merged[len(merged)-1]
			if m.End > last.End {
				last.End = m.End
			}
		}
	}

	doc := js.Global.Get("document")
	fragment := doc.Call("createDocumentFragment")
	prev := 0
	for _, m := range merged {
		if m.Start > prev {
			fragment.Call("appendChild", doc.Call("createTextNode", text[prev:m.Start]))
		}
		span := doc.Call("createElement", "span")
		span.Get("classList").Call("add", h.config.HighlightClass)
		span.Set("textContent", text[m.Start:m.End])
		fragment.Call("appendChild", span)
		prev = m.End
	}
	if prev < len(text) {
		fragment.Call("appendChild", doc.Call("createTextNode", text[prev:]))
	}

	parent := textNode.Get("parentNode")
	if parent != nil {
		parent.Call("replaceChild", fragment, textNode)
	}
}

func addDefaultCSS(className string) {
	styleID := "gopherjs-highlighter-style"
	if js.Global.Get("document").Call("getElementById", styleID) != nil {
		return
	}
	style := js.Global.Get("document").Call("createElement", "style")
	style.Set("id", styleID)
	style.Set("textContent", `.`+className+` { background-color: yellow; color: black; }`)
	js.Global.Get("document").Get("head").Call("appendChild", style)
}

func stopHighlighter() {
	if highlighter != nil && highlighter.observer != nil {
		highlighter.observer.Call("disconnect")
	}
	removeHighlights("highlightClass")
}

func removeHighlights(className string) {
	doc := js.Global.Get("document")
	nodes := doc.Call("querySelectorAll", "."+className)
	for i := 0; i < nodes.Length(); i++ {
		highlight := nodes.Index(i)
		parent := highlight.Get("parentNode")
		if parent != nil {
			text := highlight.Get("textContent")
			textNode := doc.Call("createTextNode", text)
			parent.Call("replaceChild", textNode, highlight)
		}
	}
}
