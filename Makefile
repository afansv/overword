toolset:
	go install github.com/afansv/bd@v0.4.1 && \
	bd install --clean

build:
	bd exec gopherjs build
	cat header.txt overword.js > overword_tmp.js
	mv overword_tmp.js dist/overword.js
	rm overword.js