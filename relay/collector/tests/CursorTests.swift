import Foundation
import SQLite3

private let cursorDate = Int64(epoch.timeIntervalSinceReferenceDate * 1_000_000_000) + 1_000_000_000
private func cursorFixture(_ run: (MessageSource, SQLDatabase, OutboxStore) throws -> Void) throws {
    let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
    let (source, writer) = try makeSource(root), store = try OutboxStore(directory: root)
    try store.initialize(config: config(), maxRowID: 10, at: epoch)
    try run(source, writer, store)
}
private func addCursorRow(_ writer: SQLDatabase, guid: SQLValue, body: SQLValue = .text("Fixture payment GHS 25"), date: SQLValue = .integer(cursorDate), sender: SQLValue = .integer(1), service: SQLValue = .text("SMS"), direction: SQLValue = .integer(0)) throws {
    try writer.execute("insert into message(guid,text,attributedBody,date,handle_id,service,is_from_me) values(?,?,x'000102',?,?,?,?)", [guid,body,date,sender,service,direction])
}
private func nextCursorBatch(_ source: MessageSource, _ store: OutboxStore, limit: Int = 500) throws -> CaptureBatch {
    try source.captureBatch(baseline: store.baseline(config: config()), config: config(), limit: limit, retry: store.sourceQuarantine(config: config()))
}

func testSourceQuarantine() throws {
    // The previously unsafe three-row/limit-one case: bad row plus two good
    // rows. Every raw header advances exactly once; no decoded-count shortcut.
    try cursorFixture { source, writer, store in
        try expect(store.status(config: config()).lastSuccessfulCaptureAt == nil, "baseline initialization is not a successful collection claim")
        try addCursorRow(writer, guid: .text("unreadable-first"), body: .null)
        try addCursorRow(writer, guid: .text("later-good-one"))
        try addCursorRow(writer, guid: .text("later-good-two"))
        let first = try nextCursorBatch(source, store, limit: 1)
        try expect(first.scannedRowCount == 1 && first.messages.isEmpty && first.quarantined.count == 1 && first.lastRowID == 11 && first.hasMore, "unreadable row is counted as scanned and durably quarantined at its exact cursor")
        try store.capture(first, config: config())
        try expect(store.status(config: config()).lastSuccessfulCaptureAt != nil && store.status(config: config()).sourceScanHasMore, "successful bounded capture records activity and catch-up state atomically")
        for (offset, guid) in ["later-good-one", "later-good-two"].enumerated() {
            let batch = try nextCursorBatch(source, store, limit: 1)
            try expect(batch.messages.map(\.guid) == [guid] && batch.lastRowID == Int64(12+offset), "later source rows progress independently of unreadable retry")
            try expect(batch.hasMore == (offset == 0), "raw-header lookahead reports the true remaining page")
            try store.capture(batch, config: config())
        }
        let beforeRepair = try store.status(config: config())
        try expect(!beforeRepair.sourceScanHasMore, "a quiet caught-up source is distinct from a scan backlog")
        try expect(beforeRepair.pendingCount == 2 && beforeRepair.sourceQuarantineCount == 1 && beforeRepair.unreadableSourceCount == 1 && beforeRepair.firstQuarantinedSourceRowID == 11, "health distinguishes queued alerts from unreadable source refs")
        try expect(store.db.scalarInt("select initial_rowid from baseline") == 10 && store.baseline(config: config()).initialRowID == 10, "original activation high-water remains fixed as capture advances")
        try writer.execute("update message set text='Fixture repaired payment GHS 25' where ROWID=11")
        let recovered = try nextCursorBatch(source, store, limit: 1)
        try expect(recovered.scannedRowCount == 0 && recovered.messages.isEmpty && recovered.retries.first?.message?.guid == "unreadable-first", "repair is retried by old ROWID independently of forward cursor")
        try store.capture(recovered, config: config())
        try expect(store.status(config: config()).pendingCount == 3 && store.status(config: config()).sourceQuarantineCount == 0 && store.status(config: config()).lastCapturedRowID == 13, "repaired alert recovered exactly once without cursor rewind")
        try store.capture(nextCursorBatch(source, store, limit: 1), config: config())
        try expect(store.status(config: config()).pendingCount == 3, "repeated empty collection cannot duplicate a repaired alert")
        let safe = String(data: try JSONEncoder().encode(beforeRepair), encoding: .utf8)!
        try expect(!safe.contains("unreadable-first") && !safe.contains("Fixture") && !safe.contains(config().key), "source health contains counts and safe row reference only")
        try expect(store.db.scalarInt("select count(*) from pragma_table_info('source_quarantine') where name in ('body','raw','sender','guid')") == 0, "source quarantine never copies undecoded bodies or raw sender/GUID metadata")
    }
    for label in ["sender", "service", "direction", "guid", "date"] {
        try cursorFixture { source, writer, store in
            let guid = "incomplete-"+label
            try addCursorRow(writer, guid: label == "guid" ? .null : .text(guid),
                date: label == "date" ? .null : .integer(cursorDate), sender: label == "sender" ? .null : .integer(1),
                service: label == "service" ? .null : .text("SMS"), direction: label == "direction" ? .null : .integer(0))
            try addCursorRow(writer, guid: .text("after-missing-"+label))
            let batch = try nextCursorBatch(source, store)
            try expect(batch.quarantined.count == 1 && batch.messages.map(\.guid) == ["after-missing-"+label] && batch.lastRowID == 12, "missing routing metadata does not block a later provider alert")
            try store.capture(batch, config: config())
            try expect(store.status(config: config()).incompleteSourceMetadataCount == 1, "incomplete source metadata is visible rather than silently skipped")
            try writer.execute("update message set guid=?,date=?,handle_id=1,service='SMS',is_from_me=0 where ROWID=11", [.text(guid),.integer(cursorDate)])
            let repair = try nextCursorBatch(source, store)
            try store.capture(repair, config: config())
            try expect(store.status(config: config()).pendingCount == 2 && store.status(config: config()).sourceQuarantineCount == 0, "metadata repair captures the original row without rescanning later alerts")
        }
    }
    // Missing sender is unknown until repaired. Personal/non-SMS/old history
    // becomes an explicit excluded resolution; it is never guessed into scope.
    for exclusion in ["personal", "rcs", "outgoing", "old", "credential"] {
        try cursorFixture { source, writer, store in
            try addCursorRow(writer, guid: .text("routing-unknown"), sender: .null)
            try store.capture(nextCursorBatch(source, store), config: config())
            let handle: Int64 = exclusion == "personal" ? 2 : 1
            let date = exclusion == "old" ? cursorDate - 2_000_000_000 : cursorDate
            let body = exclusion == "credential" ? "Fixture verification-code GHS 25" : "Fixture payment GHS 25"
            try writer.execute("update message set handle_id=?,date=?,service=?,is_from_me=?,text=? where ROWID=11", [.integer(handle),.integer(date),.text(exclusion == "rcs" ? "RCS" : "SMS"),.integer(exclusion == "outgoing" ? 1 : 0),.text(body)])
            try store.capture(nextCursorBatch(source, store), config: config())
            try expect(store.status(config: config()).pendingCount == 0 && store.status(config: config()).sourceQuarantineCount == 0, "repaired routing rechecks source/privacy/future fences before any enqueue")
        }
    }
    try cursorFixture { source, writer, store in
        try addCursorRow(writer, guid: .text("retained-identity"), body: .null)
        try addCursorRow(writer, guid: .text("later-anchor"))
        try store.capture(nextCursorBatch(source, store), config: config())
        try writer.execute("update message set guid='different-row-identity',text='Fixture GHS 25' where ROWID=11")
        try store.capture(nextCursorBatch(source, store), config: config())
        try expect(store.status(config: config()).sourceQuarantineCount == 1 && store.db.scalarInt("select count(*) from source_quarantine where reason='identity_changed'") == 1, "reused ROWID cannot silently replace a known quarantined GUID")
        try writer.execute("delete from message where ROWID=11")
        try addCursorRow(writer, guid: .text("after-deleted-source"))
        try store.capture(nextCursorBatch(source, store), config: config())
        try expect(store.status(config: config()).sourceQuarantineCount == 1 && store.db.scalarInt("select count(*) from source_quarantine where reason='source_missing'") == 1 && store.status(config: config()).pendingCount == 2, "deleted unreadable row stays visibly unresolved while later alerts progress")
        try writer.execute("insert into message(ROWID,guid,text,date,handle_id,service,is_from_me) values(11,'retained-identity','Fixture GHS 25',?,1,'SMS',0)", [.integer(cursorDate)])
        try store.capture(nextCursorBatch(source, store), config: config())
        try expect(store.status(config: config()).sourceQuarantineCount == 0 && store.status(config: config()).pendingCount == 3, "restored original identity can recover behind the cursor")
    }
    try cursorFixture { source, writer, store in
        try addCursorRow(writer, guid: .text("atomic-bad"), body: .null)
        try addCursorRow(writer, guid: .text("atomic-good"))
        let batch = try nextCursorBatch(source, store)
        try store.db.execute("create trigger fixture_quarantine_failure before insert on source_quarantine begin select raise(abort,'fixture write failure');end")
        try expectError("quarantine failure aborts the whole capture transaction") { try store.capture(batch, config: config()) }
        try expect(store.status(config: config()).lastCapturedRowID == 10 && store.status(config: config()).pendingCount == 0 && store.status(config: config()).sourceQuarantineCount == 0, "failed durable quarantine cannot advance cursor or lose good alerts")
        try expect(store.status(config: config()).lastSuccessfulCaptureAt == nil, "failed capture cannot report a successful health timestamp")
        try store.db.execute("drop trigger fixture_quarantine_failure")
        try store.db.execute("create trigger fixture_cursor_failure before update of last_rowid on baseline begin select raise(abort,'fixture cursor commit failure');end")
        try expectError("cursor write failure rolls back already prepared quarantine and good payload writes") { try store.capture(batch, config: config()) }
        try expect(store.status(config: config()).lastCapturedRowID == 10 && store.status(config: config()).pendingCount == 0 && store.status(config: config()).sourceQuarantineCount == 0 && store.db.scalarInt("select count(*) from seen") == 0, "cursor commit boundary retains all source work for retry")
        try store.db.execute("drop trigger fixture_cursor_failure")
        try store.capture(batch, config: config())
        let successfulCapture = try store.status(config: config()).lastSuccessfulCaptureAt
        try writer.execute("update message set text='Fixture repaired GHS 25' where ROWID=11")
        let repair = try nextCursorBatch(source, store)
        try store.db.execute("create trigger fixture_retry_failure before delete on source_quarantine begin select raise(abort,'fixture resolve failure');end")
        try expectError("failed retry resolution rolls back enqueue and source metadata together") { try store.capture(repair, config: config()) }
        try expect(store.status(config: config()).pendingCount == 1 && store.status(config: config()).sourceQuarantineCount == 1 && store.status(config: config()).lastCapturedRowID == 12, "repair persistence failure retains the original quarantine without duplicate delivery")
        try expect(store.status(config: config()).lastSuccessfulCaptureAt == successfulCapture, "a failed repair cannot falsely refresh collection health")
        try store.db.execute("drop trigger fixture_retry_failure")
        try store.capture(repair, config: config())
        try expect(store.status(config: config()).pendingCount == 2 && store.status(config: config()).sourceQuarantineCount == 0, "retry commit recovers after a local failure")
    }
    try cursorFixture { source, writer, store in
        for index in 1...105 { try addCursorRow(writer, guid: .text("unknown-routing-\(index)"), sender: .null) }
        try store.capture(nextCursorBatch(source, store), config: config())
        let first = try store.sourceQuarantine(config: config())
        try expect(first.count == 100 && store.status(config: config()).sourceQuarantineCount == 105, "quarantine preserves every header ref while bounding each retry cycle")
        try store.capture(source.captureBatch(baseline: store.baseline(config: config()), config: config(), retry: first), config: config())
        let second = try store.sourceQuarantine(config: config())
        try expect(second.first?.rowID == 111 && Set(second.map(\.rowID)).count == 100, "retry rotation reaches later unresolved headers instead of starving behind the first100")
        try expect(store.status(config: config()).sourceRetryAttempts == 100 && store.status(config: config()).lastCapturedRowID == 115, "quarantine retry metadata is independent of capture cursor")
        try expectError("initial history cannot be injected as a source retry") { _ = try source.captureBatch(baseline: store.baseline(config: config()), config: config(), retry: [SourceReference(rowID: 10, guidHash: nil)]) }
        try expectError("source retry cannot clear an uninitialized historic reference") { _ = try store.capture(CaptureBatch(messages: [], lastRowID: 115, hasMore: false, retries: [SourceRetryResult(reference: SourceReference(rowID: 10, guidHash: nil), quarantine: nil, message: nil)]), config: config()) }
    }
}
