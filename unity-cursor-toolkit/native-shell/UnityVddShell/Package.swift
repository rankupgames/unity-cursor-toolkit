// swift-tools-version: 5.7

import PackageDescription

let package = Package(
	name: "UnityVddShell",
	platforms: [
		.macOS(.v12)
	],
	products: [
		.executable(name: "UnityVddShell", targets: ["UnityVddShell"])
	],
	targets: [
		.executableTarget(name: "UnityVddShell")
	]
)
