caption-refresh = Aggiorna
autoRefresh =
  .label = Aggiorna automaticamente i riferimenti all'apertura del lettore, tranne per questi tipi
  



caption-tip = Suggerimenti
isShowTip-start = 
  .label = La finestra fluttuante verrà visualizzata dopo che il il mouse di ferma su di un riferimento per più di
isShowTip-end = ms

ctrlClickTranslate = 
  .label = All'interno della finestra fluttuante, premere CTRL e cliccare su Text Translate

shadeMillisecond-start = La finestra fluttuante sfuma per
shadeMillisecond-end = ms

removeTipAfterMillisecond-start = Sparisce completamente dopo
removeTipAfterMillisecond-end = ms

tipBackgroundColor = Colore di sfondo
tipTitleColor = Colore del titolo


caption-related = Correlati
loadingRelated = 
  .label = Il pannello dei correlati carica elementi correlati



caption-link = Link
clickLink-start = 
  .label = Click sul link per aprire una finestra divisa
clickLink-splitHorizontally = 
  .label = Orizzontalmente
clickLink-splitVertically = 
  .label = Verticalmente
clickLink-end = 
hoverLink = 
  .label = Passa il mouse sul link per mostrare una finestra fluttuante


caption-save = Salva
saveAPIReferences = 
  .label = Salva riferimenti da API (via DOI)
saveCitations = 
  .label = Salva le citazioni
save-note = Gli elenchi salvati vengono riutilizzati senza nuove interrogazioni. Usa Aggiorna nella sezione per rileggerli.


caption-match = Abbina
notInLibarayOpacity-start = Abbina elementi e rendi gli elementi che non sono nella biblioteca trasparenti
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

conversion-obsidianVault = Cassaforte Obsidian
conversion-obsidianVault-input =
  .placeholder = Nome della cassaforte
conversion-obsidianVault-note = «Apri in Obsidian» salta allora tramite l'uid della nota, che sopravvive a rinomina o spostamento nella cassaforte. Richiede il plugin Advanced URI. Se vuoto, le note si aprono per percorso.

caption-sync = Sincronizzazione WebDAV
sync-note = Sincronizza attualmente progetti, board, nodi, collegamenti e tombstone di eliminazione. Progettato per Jianguoyun WebDAV.
sync-webdav-url = URL WebDAV
sync-webdav-username = Email account
sync-webdav-password = Password applicazione
sync-webdav-password-note = Genera una password per applicazione di terze parti in Jianguoyun. Se memorizzata, resta nel gestore password sicuro di Zotero e non viene sincronizzata.
sync-remember-password =
  .label = Memorizza in modo sicuro la password su questo dispositivo
sync-auto =
  .label = Sincronizza automaticamente
sync-interval = Frequenza
sync-interval-30 = Ogni 30 minuti
sync-interval-60 = Ogni ora
sync-interval-180 = Ogni 3 ore
sync-interval-360 = Ogni 6 ore
sync-notifications = Notifiche in background
sync-notifications-errors = Solo errori
sync-notifications-all = Tutti i risultati
sync-notifications-none = Nessuna
sync-now = Sincronizza ora
sync-status-running = Sincronizzazione…
sync-status-continuing = Sincronizzazione… { $remaining } lotti rimanenti
sync-status-done = Completato: { $uploaded } caricati, { $downloaded } scaricati, { $merged } uniti, { $remaining } batch rimanenti
sync-status-deferred = { $skipped } documenti richiedono una versione più recente di UniZero e sono stati lasciati sul server.
sync-status-error = Sincronizzazione non riuscita: { $message }
sync-status-password-save-error = Sincronizzazione completata, ma non è stato possibile salvare la password dell'applicazione.
sync-status-last-success = Ultima sincronizzazione: { $time }
sync-status-last-error = Ultima sincronizzazione non riuscita: { $message }
