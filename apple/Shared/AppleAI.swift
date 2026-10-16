// The on-device Apple Intelligence model (FoundationModels, macOS / iOS 26) as a second AI
// engine next to Ollama: nothing to install or download. web/js/ai.js sends the same chat
// messages and JSON schemas it sends to Ollama; schemas become guided generation here.
// Built with an older SDK (no FoundationModels), the app simply reports it as unavailable.
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

enum AppleAI {
    /// {available, reason}: reason is device, disabled, notReady, os or build.
    static func status() -> [String: Any] {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return ["available": true]
            case .unavailable(let why):
                switch why {
                case .deviceNotEligible: return ["available": false, "reason": "device"]
                case .appleIntelligenceNotEnabled: return ["available": false, "reason": "disabled"]
                case .modelNotReady: return ["available": false, "reason": "notReady"]
                @unknown default: return ["available": false, "reason": "notReady"]
                }
            }
        }
        return ["available": false, "reason": "os"]
        #else
        return ["available": false, "reason": "build"]
        #endif
    }

    /// body: {messages: JSON [{role, content}], schema: JSON schema or null, temperature}.
    /// Calls `partial` with the text so far (plain replies only); returns the full reply.
    static func generate(_ body: [String: Any], partial: @escaping (String) -> Void) async throws -> String {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, iOS 26.0, *) {
            return try await Generator.run(body, partial: partial)
        }
        #endif
        throw AppError(message: "这台设备上没有 Apple 端侧模型")
    }
}

#if canImport(FoundationModels)
@available(macOS 26.0, iOS 26.0, *)
private enum Generator {
    static func run(_ body: [String: Any], partial: @escaping (String) -> Void) async throws -> String {
        let messages = (body["messages"] as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } as? [[String: Any]] ?? []
        let text = { (m: [String: Any]) in m["content"] as? String ?? "" }
        let system = messages.filter { $0["role"] as? String == "system" }.map(text).joined(separator: "\n\n")
        let turns = messages.filter { $0["role"] as? String != "system" }
        // the model has no separate history API here: earlier turns go into the prompt
        var prompt = ""
        if turns.count > 1 {
            prompt += "之前的对话：\n" + turns.dropLast().map { "\($0["role"] as? String == "assistant" ? "助手" : "用户")：\(text($0))" }
                .joined(separator: "\n") + "\n\n现在的问题：\n"
        }
        prompt += turns.last.map(text) ?? ""

        let session = LanguageModelSession(instructions: system)
        let options = GenerationOptions(temperature: body["temperature"] as? Double)
        do {
            if let json = body["schema"] as? String,
               let obj = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] {
                var names = 0
                let schema = try GenerationSchema(root: dynamic(obj, name: "Result", counter: &names), dependencies: [])
                let response = try await session.respond(to: prompt, schema: schema, includeSchemaInPrompt: true, options: options)
                return response.content.jsonString
            }
            var reply = ""
            for try await snapshot in session.streamResponse(to: prompt, options: options) {
                try Task.checkCancellation()
                reply = snapshot.content
                partial(reply)
            }
            return reply
        } catch let e as LanguageModelSession.GenerationError {
            switch e {
            case .exceededContextWindowSize: throw AppError(message: "内容太长，超出了 Apple 端侧模型能处理的长度。请减少卡片或缩短问题。")
            case .guardrailViolation: throw AppError(message: "Apple 端侧模型拒绝处理这段内容（安全限制）。")
            case .unsupportedLanguageOrLocale: throw AppError(message: "Apple 端侧模型暂不支持这种语言，请在系统设置里确认 Apple 智能的语言。")
            default: throw AppError(message: "Apple 端侧模型出错：\(e.localizedDescription)")
            }
        }
    }

    /// JSON schema (the subset ai.js uses) → guided generation schema.
    static func dynamic(_ s: [String: Any], name: String, counter: inout Int) throws -> DynamicGenerationSchema {
        counter += 1
        let unique = "\(name)\(counter)"
        if let choices = s["enum"] as? [String] {
            return DynamicGenerationSchema(name: unique, description: nil, anyOf: choices)
        }
        switch s["type"] as? String ?? "string" {
        case "object":
            let props = s["properties"] as? [String: Any] ?? [:]
            let required = Set(s["required"] as? [String] ?? [])
            var list: [DynamicGenerationSchema.Property] = []
            for key in props.keys.sorted() {
                guard let sub = props[key] as? [String: Any] else { continue }
                list.append(DynamicGenerationSchema.Property(name: key, description: nil,
                                                             schema: try dynamic(sub, name: key, counter: &counter),
                                                             isOptional: !required.contains(key)))
            }
            return DynamicGenerationSchema(name: unique, description: nil, properties: list)
        case "array":
            let items = s["items"] as? [String: Any] ?? ["type": "string"]
            return DynamicGenerationSchema(arrayOf: try dynamic(items, name: name, counter: &counter), minimumElements: nil, maximumElements: nil)
        case "integer":
            return DynamicGenerationSchema(type: Int.self, guides: [])
        case "number":
            return DynamicGenerationSchema(type: Double.self, guides: [])
        case "boolean":
            return DynamicGenerationSchema(type: Bool.self, guides: [])
        default:
            return DynamicGenerationSchema(type: String.self, guides: [])
        }
    }
}
#endif
