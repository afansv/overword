toolset:
	go install github.com/afansv/bd@v0.4.1 && \
	bd install --clean

build:
	bd exec gopherjs build --source_map=false
	cat header.js overword.js > overword_tmp.js
	mv overword_tmp.js dist/overword.user.js
	rm overword.js