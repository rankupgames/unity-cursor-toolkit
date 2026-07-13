using System.Runtime.CompilerServices;

// Expose the editor assembly's internals (notably UntermNative and
// UntermWindow.PluginPath / EnsureNativeImageLoaded) to the EditMode test
// assembly so tests can drive the native bundle directly. See Tests/Editor.
[assembly: InternalsVisibleTo("Unterm.Editor.Tests")]
