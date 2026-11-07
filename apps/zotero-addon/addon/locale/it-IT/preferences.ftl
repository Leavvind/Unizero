caption-tip = Suggerimenti
isShowTip =
  .label = Mostra una scheda con i dettagli quando il mouse si ferma su un riferimento


caption-save = Salva
saveAPIReferences = 
  .label = Salva riferimenti da API (via DOI)
saveCitations = 
  .label = Salva le citazioni
save-note = Gli elenchi salvati vengono riutilizzati senza nuove interrogazioni. Usa Aggiorna nella sezione per rileggerli.


caption-match = Corrispondenza in biblioteca
notInLibarayOpacity-start = Opacità dei riferimenti assenti dalla biblioteca
notInLibarayOpacity-end =

caption-api = Fonti dati
sourceOrder-note = I riferimenti vengono recuperati prima tramite DOI (OpenAlex → Crossref → Semantic Scholar). Senza DOI si ricade sui riferimenti estratti durante la conversione.
semanticScholarApiKey = Chiave API Semantic Scholar
semanticScholarApiKey-note = Facoltativa. Senza chiave le richieste sono limitate a circa 1 al secondo e falliscono spesso con 429.

caption-runtime = Servizio locale
runtime-note = La conversione dei PDF richiede il runtime Python locale. Una volta installato unizero-runtime, entrambi i percorsi possono restare vuoti.
runtime-pythonPath = Percorso di Python
runtime-pythonPath-input =
  .placeholder = Vuoto = rilevamento automatico
runtime-serverScript = Percorso di server.py
runtime-serverScript-input =
  .placeholder = Vuoto = cerca unizero-runtime installato
runtime-port = Porta
runtime-port-note = Ha effetto al prossimo avvio del servizio
runtime-autoStart =
  .label = Avvia il servizio in background all'avvio di Zotero
runtime-autoStopOnQuit =
  .label = Ferma il servizio all'uscita di Zotero (solo quello avviato da questo componente)

caption-conversion = Conversione
conversion-mdSnapshot =
  .label = Salva una copia Markdown sull'elemento dopo la conversione
conversion-note = La copia si sincronizza con Zotero ed è leggibile su altri computer, al costo di essere sovrascritta a ogni riconversione.

conversion-defaultTemplate = Modello predefinito
conversion-defaultTemplate-note = Usato quando una conversione non indica un modello: Obsidian impostato sul predefinito di Zotero, il server MCP e il menu dell'elemento a runtime fermo. L'elenco mostra i modelli del runtime in esecuzione.
