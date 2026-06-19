import SwiftUI
import WebKit
import Foundation

struct ShellArguments {
	let manifestPath: String
	let streamUrl: String
	let controlUrl: String
	let title: String

	static func parse(_ args: [String]) -> ShellArguments {
		func value(_ key: String, _ fallback: String) -> String {
			if let index = args.firstIndex(of: key), index + 1 < args.count {
				return args[index + 1]
			}
			let prefix = key + "="
			return args.first(where: { $0.hasPrefix(prefix) }).map { String($0.dropFirst(prefix.count)) } ?? fallback
		}

		return ShellArguments(
			manifestPath: value("--manifest", ""),
			streamUrl: value("--stream-url", "http://127.0.0.1:48170/viewport.mjpg"),
			controlUrl: value("--control-url", "http://127.0.0.1:48171"),
			title: value("--title", "Unity VDD Shell")
		)
	}
}

final class ShellModel: ObservableObject {
	let args: ShellArguments
	@Published var statusText: String = "Connecting..."

	init(args: ShellArguments) {
		self.args = args
	}

	func startPolling() {
		Task {
			while true {
				await updateStatus()
				try? await Task.sleep(nanoseconds: 1_000_000_000)
			}
		}
	}

	@MainActor
	private func setStatus(_ text: String) {
		statusText = text
	}

	private func updateStatus() async {
		guard let url = URL(string: args.controlUrl + "/status.json") else {
			await setStatus("Invalid control URL")
			return
		}

		do {
			let (data, _) = try await URLSession.shared.data(from: url)
			if let text = String(data: data, encoding: .utf8), text.contains("\"success\"") {
				await setStatus("Live")
			} else {
				await setStatus("Status unavailable")
			}
		} catch {
			await setStatus("Waiting for remote host")
		}
	}
}

struct ContentView: View {
	@ObservedObject var model: ShellModel

	var body: some View {
		VStack(spacing: 0) {
			HStack {
				Text(model.args.title)
					.font(.headline)
				Spacer()
				Text(model.statusText)
					.foregroundStyle(.secondary)
			}
			.padding(10)
			.background(Color(nsColor: .windowBackgroundColor))

			StreamWebView(streamUrl: model.args.streamUrl, controlUrl: model.args.controlUrl)
				.frame(minWidth: 960, minHeight: 540)
		}
		.onAppear {
			model.startPolling()
		}
	}
}

struct StreamWebView: NSViewRepresentable {
	let streamUrl: String
	let controlUrl: String

	func makeNSView(context: Context) -> WKWebView {
		let config = WKWebViewConfiguration()
		let webView = WKWebView(frame: .zero, configuration: config)
		webView.setValue(false, forKey: "drawsBackground")
		webView.loadHTMLString(html(), baseURL: nil)
		return webView
	}

	func updateNSView(_ nsView: WKWebView, context: Context) {
	}

	private func html() -> String {
		let escapedStream = escape(streamUrl)
		let escapedControl = escape(controlUrl)
		return """
		<!doctype html>
		<html>
		<head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width, initial-scale=1">
			<style>
				html, body { margin: 0; width: 100%; height: 100%; background: #05070b; overflow: hidden; }
				#viewport { width: 100vw; height: 100vh; object-fit: contain; display: block; background: #05070b; }
			</style>
		</head>
		<body>
			<img id="viewport" src="\(escapedStream)" draggable="false" />
			<script>
				const controlUrl = "\(escapedControl)";
				function send(type, event) {
					const rect = document.getElementById('viewport').getBoundingClientRect();
					fetch(controlUrl + '/input', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							type,
							x: Math.round(event.clientX - rect.left),
							y: Math.round(event.clientY - rect.top)
						})
					}).catch(() => {});
				}
				window.addEventListener('mousemove', event => send('move', event));
				window.addEventListener('mousedown', event => send('pointerDown', event));
				window.addEventListener('mouseup', event => send('pointerUp', event));
				window.addEventListener('keydown', event => {
					fetch(controlUrl + '/input', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ type: 'key', key: event.key, keyCode: event.keyCode || event.which || 0 })
					}).catch(() => {});
				});
			</script>
		</body>
		</html>
		"""
	}

	private func escape(_ value: String) -> String {
		value
			.replacingOccurrences(of: "\\", with: "\\\\")
			.replacingOccurrences(of: "\"", with: "\\\"")
			.replacingOccurrences(of: "\n", with: "\\n")
	}
}

@main
struct UnityVddShellApp: App {
	private let model = ShellModel(args: ShellArguments.parse(Array(CommandLine.arguments.dropFirst())))

	var body: some Scene {
		WindowGroup(model.args.title) {
			ContentView(model: model)
		}
	}
}
