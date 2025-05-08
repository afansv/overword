package main

import (
	"strings"

	"github.com/gopherjs/gopherjs/js"
)

var predefinedSets = []struct {
	Code            string
	Name            string
	BackgroundColor string
	TextColor       string
}{
	{"yellow", "Жёлтый", "yellow", "black"},
	{"red", "Красный", "red", "white"},
	{"orange", "Оранжевый", "orange", "black"},
	{"green", "Зелёный", "green", "white"},
	{"blue", "Синий", "blue", "white"},
}

type WordSet struct {
	Code            string
	Words           []string
	BackgroundColor string
	TextColor       string
}

type Config struct {
	WordSets       []*WordSet
	HighlightClass string
	DebounceTime   int
	gmc            *js.Object
}

func (cfg *Config) Register() {
	slotFactory := func(name string) map[string]interface{} {
		return map[string]interface{}{
			"name": "Категория: " + name,
			"type": "folder",
			"items": map[string]interface{}{
				"words": map[string]interface{}{
					"name": "Слова (через запятую)",
					"type": "str",
				},
			},
		}
	}

	slots := make(map[string]interface{})
	for _, def := range predefinedSets {
		slots[def.Code] = slotFactory(strings.Title(def.Name))
	}

	cfg.gmc = gmConfig.New(slots)
}

func (cfg *Config) Load() {
	if cfg.gmc == nil {
		cfg.Register()
	}

	cfg.WordSets = make([]*WordSet, 0, len(predefinedSets))
	for _, def := range predefinedSets {
		raw := cfg.gmc.Call("get", def.Code+".words").String()
		words := parseWords(raw)
		cfg.WordSets = append(cfg.WordSets, &WordSet{
			Code:            def.Code,
			TextColor:       def.TextColor,
			BackgroundColor: def.BackgroundColor,
			Words:           words,
		})
	}
}

func (cfg *Config) AddListener(callback func()) {
	if cfg.gmc == nil {
		cfg.Register()
	}

	cfg.gmc.Call("addEventListener", "set", func(e *js.Object) {
		prop := e.Get("detail").Get("prop").String()
		if !strings.HasSuffix(prop, ".words") {
			return
		}

		setCode := strings.TrimSuffix(prop, ".words")
		wordSet := cfg.findWordSet(setCode)
		if wordSet == nil {
			return
		}

		value := e.Get("detail").Get("after").String()
		wordSet.Words = parseWords(value)
		callback()
	})
}

func (cfg *Config) findWordSet(code string) *WordSet {
	for _, ws := range cfg.WordSets {
		if ws.Code == code {
			return ws
		}
	}
	return nil
}

func parseWords(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.Split(value, ",")
}
