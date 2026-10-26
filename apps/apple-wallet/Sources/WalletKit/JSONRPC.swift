import Foundation
import BigInt

private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

public actor JSONRPC {
    private let endpoint: URL
    private let session: URLSession
    private var nextID: Int = 0
    public init(endpoint: URL, configuration: URLSessionConfiguration = .ephemeral) {
        self.endpoint = endpoint
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }

    public func call(_ method: String, _ params: [Any] = []) async throws -> Any {
        try Task.checkCancellation()
        _ = try EndpointPolicy.validate(endpoint.absoluteString)
        nextID += 1
        let id = nextID
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "method": method, "params": params])
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  response.expectedContentLength <= 2_000_000 else { throw WalletFailure.invalidResponse }
            var data = Data()
            for try await byte in bytes {
                guard data.count < 2_000_000 else { throw WalletFailure.invalidResponse }
                data.append(byte)
            }
            try Task.checkCancellation()
            guard
                  let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  envelope["jsonrpc"] as? String == "2.0", envelope["id"] as? Int == id else { throw WalletFailure.invalidResponse }
            guard envelope["error"] == nil, let result = envelope["result"] else { throw WalletFailure.serviceUnavailable }
            return result
        } catch let error as WalletFailure { throw error }
        catch is CancellationError { throw CancellationError() }
        catch { throw WalletFailure.serviceUnavailable }
    }

    public static func quantity(_ value: Any) throws -> BigUInt {
        guard let string = value as? String, string.hasPrefix("0x"), string.count > 2, string.count <= 66,
              let number = BigUInt(string.dropFirst(2), radix: 16) else { throw WalletFailure.invalidResponse }
        return number
    }
    public static func hex(_ number: BigUInt) -> String { "0x" + String(number, radix: 16) }
}
