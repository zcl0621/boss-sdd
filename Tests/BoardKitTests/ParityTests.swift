import Foundation
import Testing
@testable import BoardKit

/// Compares `deriveGraph` against the projections produced by the previous Python
/// board on the same runs. Set BOARD_PARITY_DIR to a directory holding the legacy
/// run JSON files plus `py_graphs.json` (a map of run id -> Python projection).
@Suite struct ParityTests {
    @Test func swiftProjectionMatchesPython() throws {
        guard let path = ProcessInfo.processInfo.environment["BOARD_PARITY_DIR"] else { return }
        let directory = URL(fileURLWithPath: path)
        let expectedData = try Data(contentsOf: directory.appendingPathComponent("py_graphs.json"))
        let expected = try JSONSerialization.jsonObject(with: expectedData) as! [String: Any]
        #expect(!expected.isEmpty)

        for (runID, pythonGraph) in expected {
            let runData = try Data(contentsOf: directory.appendingPathComponent("\(runID).json"))
            let run = try LegacyImport.parseRun(data: runData)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            let swiftData = try encoder.encode(deriveGraph(run))
            let swiftGraph = try JSONSerialization.jsonObject(with: swiftData) as! [String: Any]

            let differences = diff(expected: pythonGraph as! [String: Any], actual: swiftGraph)
            let report = "run \(runID):\n" + differences.joined(separator: "\n")
            #expect(differences.isEmpty, Comment(rawValue: report))
        }
    }

    private func diff(expected: [String: Any], actual: [String: Any], path: String = "") -> [String] {
        var problems: [String] = []
        for key in Set(expected.keys).union(actual.keys).sorted() {
            let here = path.isEmpty ? key : "\(path).\(key)"
            switch (expected[key], actual[key]) {
            case (nil, _): problems.append("\(here): only in Swift")
            case (_, nil): problems.append("\(here): only in Python")
            case (let left?, let right?):
                problems.append(contentsOf: compare(left, right, path: here))
            }
        }
        return problems
    }

    private func compare(_ left: Any, _ right: Any, path: String) -> [String] {
        if let left = left as? [String: Any], let right = right as? [String: Any] {
            return diff(expected: left, actual: right, path: path)
        }
        if let left = left as? [Any], let right = right as? [Any] {
            guard left.count == right.count else {
                return ["\(path): length \(left.count) (python) vs \(right.count) (swift)"]
            }
            return zip(left, right).enumerated().flatMap { index, pair in
                compare(pair.0, pair.1, path: "\(path)[\(index)]")
            }
        }
        let leftText = String(describing: left), rightText = String(describing: right)
        return leftText == rightText ? [] : ["\(path): \(leftText) (python) vs \(rightText) (swift)"]
    }
}
