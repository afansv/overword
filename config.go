package main

import (
	"strings"

	"github.com/gopherjs/gopherjs/js"
)

type WordSet struct {
	Name            string   `json:"name"`
	Words           []string `json:"words"`
	BackgroundColor string   `json:"backgroundColor"`
	TextColor       string   `json:"textColor"`
}

type Config struct {
	WordSets       []*WordSet
	HighlightClass string
	DebounceTime   int

	gmc *js.Object
}

func (cfg *Config) AddListener(callback func()) {
	if cfg.gmc == nil {
		cfg.Register()
	}
	cfg.gmc.Call("addEventListener", "set", func(e *js.Object) {
		prop := e.Get("detail").Get("prop")
		if !strings.HasSuffix(prop.String(), ".words") {
			return
		}
		setName := strings.TrimSuffix(prop.String(), ".words")
		var wordSet *WordSet
		for _, ws := range cfg.WordSets {
			if ws.Name == setName {
				wordSet = ws
			}
		}
		if wordSet == nil {
			return
		}

		value := e.Get("detail").Get("after").String()
		if value == "" {
			wordSet.Words = nil
			callback()
			return
		}
		words := strings.Split(value, ",")
		wordSet.Words = words

		callback()
	})
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

	cfg.gmc = gmConfig.New(map[string]interface{}{
		"red":    slotFactory("Красный"),
		"yellow": slotFactory("Жёлтый"),
		"orange": slotFactory("Оранжевый"),
		"green":  slotFactory("Зелёный"),
		"blue":   slotFactory("Синий"),
	})
}

func (cfg *Config) Load() {
	if cfg.gmc == nil {
		cfg.Register()
	}

	cfg.WordSets = []*WordSet{
		{
			Name:            "yellow",
			TextColor:       "black",
			BackgroundColor: "yellow",
			Words:           strings.Split(cfg.gmc.Call("get", "yellow.words").String(), ","),
		},
		{
			Name:            "red",
			TextColor:       "white",
			BackgroundColor: "red",
			Words:           strings.Split(cfg.gmc.Call("get", "red.words").String(), ","),
		},
		{
			Name:            "orange",
			TextColor:       "black",
			BackgroundColor: "orange",
			Words:           strings.Split(cfg.gmc.Call("get", "orange.words").String(), ","),
		},
		{
			Name:            "green",
			TextColor:       "white",
			BackgroundColor: "green",
			Words:           strings.Split(cfg.gmc.Call("get", "green.words").String(), ","),
		},
		{
			Name:            "blue",
			TextColor:       "white",
			BackgroundColor: "blue",
			Words:           strings.Split(cfg.gmc.Call("get", "blue.words").String(), ","),
		},
	}
}
