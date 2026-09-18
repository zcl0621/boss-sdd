import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

struct SQLiteError: Error, CustomStringConvertible {
    let code: Int32
    let message: String
    var description: String { "sqlite error \(code): \(message)" }
}

/// Minimal SQLite3 wrapper. Not thread-safe on its own; `Store` serializes access.
final class Database {
    private var handle: OpaquePointer?

    init(path: String) throws {
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let status = sqlite3_open_v2(path, &handle, flags, nil)
        guard status == SQLITE_OK, handle != nil else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close_v2(handle)
            throw SQLiteError(code: status, message: message)
        }
        sqlite3_busy_timeout(handle, 5000)
        try execute("PRAGMA journal_mode = WAL")
        try execute("PRAGMA synchronous = NORMAL")
        try execute("PRAGMA foreign_keys = ON")
    }

    deinit { sqlite3_close_v2(handle) }

    private func fail() -> SQLiteError {
        SQLiteError(code: sqlite3_errcode(handle), message: String(cString: sqlite3_errmsg(handle)))
    }

    func execute(_ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(handle, sql, nil, nil, &error) != SQLITE_OK {
            let message = error.map { String(cString: $0) } ?? "exec failed"
            sqlite3_free(error)
            throw SQLiteError(code: sqlite3_errcode(handle), message: message)
        }
    }

    func run(_ sql: String, _ bindings: [SQLValue] = []) throws {
        let statement = try prepare(sql, bindings)
        defer { sqlite3_finalize(statement) }
        let status = sqlite3_step(statement)
        guard status == SQLITE_DONE || status == SQLITE_ROW else { throw fail() }
    }

    func query(_ sql: String, _ bindings: [SQLValue] = []) throws -> [Row] {
        let statement = try prepare(sql, bindings)
        defer { sqlite3_finalize(statement) }
        var rows: [Row] = []
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { break }
            guard status == SQLITE_ROW else { throw fail() }
            var values: [String: SQLValue] = [:]
            for index in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, index))
                switch sqlite3_column_type(statement, index) {
                case SQLITE_INTEGER: values[name] = .int(sqlite3_column_int64(statement, index))
                case SQLITE_FLOAT: values[name] = .double(sqlite3_column_double(statement, index))
                case SQLITE_NULL: values[name] = .null
                default:
                    if let text = sqlite3_column_text(statement, index) {
                        values[name] = .text(String(cString: text))
                    } else {
                        values[name] = .null
                    }
                }
            }
            rows.append(Row(values: values))
        }
        return rows
    }

    func transaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    private func prepare(_ sql: String, _ bindings: [SQLValue]) throws -> OpaquePointer? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else { throw fail() }
        for (offset, value) in bindings.enumerated() {
            let index = Int32(offset + 1)
            let status: Int32
            switch value {
            case .null: status = sqlite3_bind_null(statement, index)
            case .int(let number): status = sqlite3_bind_int64(statement, index, number)
            case .double(let number): status = sqlite3_bind_double(statement, index, number)
            case .text(let text): status = sqlite3_bind_text(statement, index, text, -1, sqliteTransient)
            }
            guard status == SQLITE_OK else {
                sqlite3_finalize(statement)
                throw fail()
            }
        }
        return statement
    }
}

enum SQLValue {
    case null
    case int(Int64)
    case double(Double)
    case text(String)
}

struct Row {
    let values: [String: SQLValue]

    func string(_ name: String) -> String {
        if case .text(let text) = values[name] ?? .null { return text }
        return ""
    }

    func optionalString(_ name: String) -> String? {
        if case .text(let text) = values[name] ?? .null { return text }
        return nil
    }

    func double(_ name: String) -> Double {
        switch values[name] ?? .null {
        case .double(let number): return number
        case .int(let number): return Double(number)
        default: return 0
        }
    }

    func optionalDouble(_ name: String) -> Double? {
        switch values[name] ?? .null {
        case .double(let number): return number
        case .int(let number): return Double(number)
        default: return nil
        }
    }

    func int(_ name: String) -> Int {
        switch values[name] ?? .null {
        case .int(let number): return Int(number)
        case .double(let number): return Int(number)
        default: return 0
        }
    }
}
