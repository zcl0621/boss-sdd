import Foundation

public struct GraphError: Codable, Sendable, Hashable {
    public var code: String
    public var message: String
    public var taskID: String?
    public var taskIDs: [String]?

    enum CodingKeys: String, CodingKey {
        case code, message
        case taskID = "task_id"
        case taskIDs = "task_ids"
    }
}

public struct ResourceConflict: Codable, Sendable, Hashable {
    public var taskID: String
    public var resources: [String]

    enum CodingKeys: String, CodingKey {
        case taskID = "task_id"
        case resources
    }
}

public struct BlockedBy: Codable, Sendable, Hashable {
    public var dependencyTaskIDs: [String] = []
    public var resourceConflicts: [ResourceConflict] = []

    enum CodingKeys: String, CodingKey {
        case dependencyTaskIDs = "dependency_task_ids"
        case resourceConflicts = "resource_conflicts"
    }
}

/// Deterministic read-only projection of a run's task DAG.
///
/// The board UI and the scheduling agent both read this; neither derives edges
/// from prose. Ported from the Python board so existing runs project identically.
public struct GraphProjection: Codable, Sendable {
    public var schemaVersion: Int = 1
    public var dependencyMetadataPresent: Bool
    public var valid: Bool
    public var errors: [GraphError]
    public var topologicalOrder: [String]
    public var topologicalLayers: [[String]]
    public var readyTaskIDs: [String]
    public var dependencies: [String: [String]]
    public var dependents: [String: [String]]
    public var waitingOn: [String: [String]]
    public var blockedBy: [String: BlockedBy]
    public var writeScopes: [String: [String]]
    public var exclusiveResources: [String: [String]]

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case dependencyMetadataPresent = "dependency_metadata_present"
        case valid, errors
        case topologicalOrder = "topological_order"
        case topologicalLayers = "topological_layers"
        case readyTaskIDs = "ready_task_ids"
        case dependencies, dependents
        case waitingOn = "waiting_on"
        case blockedBy = "blocked_by"
        case writeScopes = "write_scopes"
        case exclusiveResources = "exclusive_resources"
    }
}

private func deduped(_ values: [String]) -> [String] {
    var seen = Set<String>()
    return values.filter { value in
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return false }
        return seen.insert(value).inserted
    }
}

private func findCycle(taskIDs: [String], dependencies: [String: [String]]) -> [String] {
    var state: [String: Int] = [:]
    var stack: [String] = []
    var positions: [String: Int] = [:]

    func visit(_ taskID: String) -> [String]? {
        state[taskID] = 1
        positions[taskID] = stack.count
        stack.append(taskID)
        for dependency in dependencies[taskID] ?? [] {
            guard dependency != taskID, dependencies[dependency] != nil else { continue }
            if (state[dependency] ?? 0) == 0 {
                if let cycle = visit(dependency) { return cycle }
            } else if state[dependency] == 1, let start = positions[dependency] {
                return Array(stack[start...]) + [dependency]
            }
        }
        stack.removeLast()
        positions[taskID] = nil
        state[taskID] = 2
        return nil
    }

    for taskID in taskIDs where (state[taskID] ?? 0) == 0 {
        if let cycle = visit(taskID) { return cycle }
    }
    return []
}

public func deriveGraph(_ run: Run) -> GraphProjection {
    var errors: [GraphError] = []
    var tasks: [String: BoardTask] = [:]
    var taskIDs: [String] = []
    var dependencies: [String: [String]] = [:]
    var writeScopes: [String: [String]] = [:]
    var exclusiveResources: [String: [String]] = [:]

    for task in run.tasks {
        guard !task.id.isEmpty else {
            errors.append(GraphError(code: "invalid_task_id", message: "Task requires a non-empty ID"))
            continue
        }
        if tasks[task.id] != nil {
            errors.append(GraphError(
                code: "duplicate_task_id",
                message: "Duplicate task ID: \(task.id)",
                taskID: task.id
            ))
            continue
        }
        tasks[task.id] = task
        taskIDs.append(task.id)
        dependencies[task.id] = deduped(task.dependsOn)
        writeScopes[task.id] = deduped(task.writeScope)
        exclusiveResources[task.id] = deduped(task.exclusiveResource)
    }

    var dependents = Dictionary(uniqueKeysWithValues: taskIDs.map { ($0, [String]()) })
    var validDependencies = dependents
    for taskID in taskIDs {
        for dependency in dependencies[taskID] ?? [] {
            if dependency == taskID {
                errors.append(GraphError(
                    code: "self_dependency",
                    message: "Task \(taskID) depends on itself",
                    taskID: taskID
                ))
            } else if tasks[dependency] == nil {
                errors.append(GraphError(
                    code: "unknown_dependency",
                    message: "Task \(taskID) depends on unknown task \(dependency)",
                    taskID: taskID,
                    taskIDs: [dependency]
                ))
            } else {
                validDependencies[taskID]?.append(dependency)
                dependents[dependency]?.append(taskID)
            }
        }
    }

    var position: [String: Int] = [:]
    for (index, taskID) in taskIDs.enumerated() { position[taskID] = index }

    var indegrees = validDependencies.mapValues(\.count)
    var currentLayer = taskIDs.filter { indegrees[$0] == 0 }
    var topologicalLayers: [[String]] = []
    var topologicalOrder: [String] = []
    while !currentLayer.isEmpty {
        topologicalLayers.append(currentLayer)
        topologicalOrder.append(contentsOf: currentLayer)
        var nextLayer: [String] = []
        for taskID in currentLayer {
            for dependent in dependents[taskID] ?? [] {
                indegrees[dependent, default: 0] -= 1
                if indegrees[dependent] == 0 { nextLayer.append(dependent) }
            }
        }
        currentLayer = nextLayer.sorted { (position[$0] ?? 0) < (position[$1] ?? 0) }
    }

    if topologicalOrder.count != taskIDs.count {
        let cycle = findCycle(taskIDs: taskIDs, dependencies: validDependencies)
        errors.append(GraphError(
            code: "cycle",
            message: "Dependency cycle: " + cycle.joined(separator: " -> "),
            taskIDs: cycle
        ))
    }

    var waitingOn: [String: [String]] = [:]
    var blockedBy: [String: BlockedBy] = [:]
    for taskID in taskIDs {
        waitingOn[taskID] = (dependencies[taskID] ?? []).filter { dependency in
            tasks[dependency]?.status != .done
        }
        blockedBy[taskID] = BlockedBy()
    }

    let graphValid = errors.isEmpty
    if graphValid {
        // Topological order guarantees every dependency is resolved before its dependents,
        // so transitive blockers accumulate in a single pass.
        for taskID in topologicalOrder {
            var unfinished = Set<String>()
            for dependency in dependencies[taskID] ?? [] where tasks[dependency]?.status != .done {
                unfinished.insert(dependency)
                unfinished.formUnion(blockedBy[dependency]?.dependencyTaskIDs ?? [])
            }
            blockedBy[taskID]?.dependencyTaskIDs = unfinished.sorted {
                (position[$0] ?? 0) < (position[$1] ?? 0)
            }
        }
    }

    let holders = taskIDs.filter { tasks[$0]?.status.isActive == true }
    for taskID in taskIDs {
        let resources = Set(exclusiveResources[taskID] ?? [])
        guard !resources.isEmpty else { continue }
        for holderID in holders where holderID != taskID {
            let overlap = resources.intersection(exclusiveResources[holderID] ?? [])
            if !overlap.isEmpty {
                blockedBy[taskID]?.resourceConflicts.append(
                    ResourceConflict(taskID: holderID, resources: overlap.sorted())
                )
            }
        }
    }

    let readyTaskIDs = graphValid
        ? topologicalOrder.filter { tasks[$0]?.status == .pending && waitingOn[$0]?.isEmpty == true }
        : []

    return GraphProjection(
        dependencyMetadataPresent: true,
        valid: graphValid,
        errors: errors,
        topologicalOrder: topologicalOrder,
        topologicalLayers: topologicalLayers,
        readyTaskIDs: readyTaskIDs,
        dependencies: dependencies,
        dependents: dependents,
        waitingOn: waitingOn,
        blockedBy: blockedBy,
        writeScopes: writeScopes,
        exclusiveResources: exclusiveResources
    )
}
