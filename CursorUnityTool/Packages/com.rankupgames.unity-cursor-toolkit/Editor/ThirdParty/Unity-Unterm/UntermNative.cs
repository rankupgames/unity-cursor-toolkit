using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>
    /// Dynamic-library loader for the Unterm native terminal plugin (macOS +
    /// Windows).
    ///
    /// Terminals live in process globals on the native side (the registry keyed
    /// by a stable u64 id), so they survive Unity C# domain reloads. We bind to
    /// the SAME native image Unity loads as an editor plugin (LoadLibrary by base
    /// name on Windows; dlopen of the resolved path with RTLD_NOLOAD on macOS),
    /// which Unity keeps mapped across reloads — so the registry persists and each
    /// window re-adopts its own serialized id. Binding to Unity's image also means
    /// UnityPluginLoad (which captures the editor's graphics device) ran there, so
    /// the renderer uses that device directly — no shadow copy, no device bridge.
    /// </summary>
    internal sealed class UntermNative : IDisposable
    {
        // --- platform dynamic-loader shim -------------------------------------
#if UNITY_EDITOR_WIN
        [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr LoadLibrary(string path);
        // GetProcAddress takes an ANSI symbol name regardless of the wide module API.
        [DllImport("kernel32", SetLastError = true)]
        private static extern IntPtr GetProcAddress(IntPtr handle, [MarshalAs(UnmanagedType.LPStr)] string symbol);
        [DllImport("kernel32", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FreeLibrary(IntPtr handle);

        private static IntPtr NativeOpen(string path) => LoadLibrary(path);
        private static IntPtr NativeSym(IntPtr handle, string symbol) => GetProcAddress(handle, symbol);
        private static void NativeClose(IntPtr handle) => FreeLibrary(handle);
        private static string NativeError() =>
            new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message;
#else
        private const int RTLD_NOW = 2;
        private const int RTLD_LOCAL = 4;

        [DllImport("/usr/lib/libSystem.B.dylib")]
        private static extern IntPtr dlopen(string path, int mode);
        [DllImport("/usr/lib/libSystem.B.dylib")]
        private static extern IntPtr dlsym(IntPtr handle, string symbol);
        [DllImport("/usr/lib/libSystem.B.dylib")]
        private static extern int dlclose(IntPtr handle);
        [DllImport("/usr/lib/libSystem.B.dylib")]
        private static extern IntPtr dlerror();

        private static IntPtr NativeOpen(string path) => dlopen(path, RTLD_NOW | RTLD_LOCAL);
        private static IntPtr NativeSym(IntPtr handle, string symbol) => dlsym(handle, symbol);
        private static void NativeClose(IntPtr handle) => dlclose(handle);
        private static string NativeError()
        {
            var p = dlerror();
            return p == IntPtr.Zero ? "(no error)" : Marshal.PtrToStringAnsi(p);
        }
#endif

        // --- terminal registry C ABI (id-based; survives reload) ---
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong CreateSeededFn(ulong id, uint w, uint h, float scale, [MarshalAs(UnmanagedType.LPUTF8Str)] string cwd, [MarshalAs(UnmanagedType.LPUTF8Str)] string seed);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong CreateDeadFn(ulong id, uint w, uint h, float scale, [MarshalAs(UnmanagedType.LPUTF8Str)] string seed);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong CreateFn(uint w, uint h, float scale, [MarshalAs(UnmanagedType.LPUTF8Str)] string cwd);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong CreateCommandFn(uint w, uint h, float scale, [MarshalAs(UnmanagedType.LPUTF8Str)] string cwd, [MarshalAs(UnmanagedType.LPUTF8Str)] string command);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool ExistsFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void IdFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void ResizeFn(ulong id, uint w, uint h, float scale);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void SetScaleFn(ulong id, float scale);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void SetFontFn(ulong id, [MarshalAs(UnmanagedType.LPUTF8Str)] string path);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void SetFontSizeFn(ulong id, float points);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void SetColorsFn(ulong id, uint fg, uint bg, uint cursor);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void SetFocusFn(ulong id, [MarshalAs(UnmanagedType.I1)] bool focused);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void SendTextFn(ulong id, [MarshalAs(UnmanagedType.LPUTF8Str)] string text);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void SendKeyFn(ulong id, [MarshalAs(UnmanagedType.LPUTF8Str)] string name, [MarshalAs(UnmanagedType.I1)] bool ctrl, [MarshalAs(UnmanagedType.I1)] bool alt, [MarshalAs(UnmanagedType.I1)] bool shift);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void ScrollFn(ulong id, int delta);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void SelStartFn(ulong id, float x, float y, byte mode);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void SelUpdateFn(ulong id, float x, float y);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool BoolFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr PtrFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void SizeFn(ulong id, out uint a, out uint b);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void ScrollStateFn(ulong id, out uint history, out uint offset, out uint screen);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool CursorPxFn(ulong id, out float x, out float y, out float w, out float h);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr TitleFn(ulong id, out UIntPtr len);

        // --- shared MCP server bridge (editor-global; no terminal id) ---
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr McpBufFn(out UIntPtr len);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void McpSetToolsFn([MarshalAs(UnmanagedType.LPUTF8Str)] string json);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void McpRespondFn(ulong id, [MarshalAs(UnmanagedType.LPUTF8Str)] string resultJson);

        // --- agent view (id-based; owns session + transcript panel + input box;
        // survives reload via a process-global registry). All symbols prefixed
        // `unterm_agentview_`. ---
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong AvCreateFn([MarshalAs(UnmanagedType.LPUTF8Str)] string cwd, uint pw, uint ph, uint iw, uint ih, [MarshalAs(UnmanagedType.LPUTF8Str)] string effort, [MarshalAs(UnmanagedType.LPUTF8Str)] string claudeCmd);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong AvLoadFn([MarshalAs(UnmanagedType.LPUTF8Str)] string cwd, [MarshalAs(UnmanagedType.LPUTF8Str)] string resume, uint pw, uint ph, uint iw, uint ih, [MarshalAs(UnmanagedType.LPUTF8Str)] string effort, [MarshalAs(UnmanagedType.LPUTF8Str)] string claudeCmd);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool AvExistsFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void AvVoidFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint AvPollFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void AvResizeFn(ulong id, uint pw, uint ph, uint iw, uint ih, float scale);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void AvThemeFn(ulong id, double br, double bg, double bb, double ba, byte fr, byte fg, byte fb);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void AvFontsFn(ulong id, [MarshalAs(UnmanagedType.LPUTF8Str)] string regular, [MarshalAs(UnmanagedType.LPUTF8Str)] string bold, [MarshalAs(UnmanagedType.LPUTF8Str)] string italic, [MarshalAs(UnmanagedType.LPUTF8Str)] string boldItalic);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr AvPtrFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr AvBufFn(ulong id, out UIntPtr len);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr AvTokenFn(ulong id, float x, float y, out UIntPtr len);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong AvStampAtFn(ulong id, float x, float y);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr FormatRelativeFn(ulong unixSecs, out UIntPtr len);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong SessionsQueryFn([MarshalAs(UnmanagedType.LPUTF8Str)] string cwd, UIntPtr limit, [MarshalAs(UnmanagedType.LPUTF8Str)] string query);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr SessionsPollFn(ulong serial, out UIntPtr len);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong SessionsGenFn();
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void AvSetBrowsingFn(ulong id, byte on);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate byte AvBrowseHoverFn(ulong id, float x, float y);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong AvBrowseCountFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr SessionsOpenElsewhereFn([MarshalAs(UnmanagedType.LPUTF8Str)] string cwd, out UIntPtr len);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate float AvFloatFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong U64IdFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void AvF1Fn(ulong id, float v);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void AvCaretFn(ulong id, out float x, out float y, out float w, out float h);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate byte AvDownFn(ulong id, float x, float y);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void AvDragFn(ulong id, float x, float y);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate byte AvScrollHFn(ulong id, float x, float y, float dx);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool AvBoolFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate byte AvInputDownFn(ulong id, float x, float y, byte kind);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void AvInputKeyFn(ulong id, [MarshalAs(UnmanagedType.LPUTF8Str)] string name, [MarshalAs(UnmanagedType.I1)] bool ctrl, [MarshalAs(UnmanagedType.I1)] bool alt, [MarshalAs(UnmanagedType.I1)] bool shift);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void AvStrFn(ulong id, [MarshalAs(UnmanagedType.LPUTF8Str)] string text);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint AvUintGetFn(ulong id);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void AvUintSetFn(ulong id, uint v);

        // --- code editor view (id-based; tree-sitter highlighting + line-number
        // gutter; survives reload via a process-global registry). Symbols prefixed
        // `unterm_editor_`. Most calls reuse the Av*/terminal delegate shapes. ---
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate ulong EdCreateFn(uint w, uint h, float scale);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void EdThemeFn(ulong id, double br, double bg, double bb, double ba, byte fr, byte fg, byte fb, [MarshalAs(UnmanagedType.I1)] bool dark);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void EdMouseFn(ulong id, float x, float y, byte kind);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool EdHoverFn(ulong id, float x, float y);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int EdHunkAtFn(ulong id, float x, float y);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool EdStageHunkFn(ulong id, uint hunk);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint EdLineAtYFn(ulong id, float y);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void EdSetBpsFn(ulong id, IntPtr lines, UIntPtr count);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void EdSetBoolFn(ulong id, [MarshalAs(UnmanagedType.I1)] bool on);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] [return: MarshalAs(UnmanagedType.I1)] private delegate bool EdFindFn(ulong id, [MarshalAs(UnmanagedType.LPUTF8Str)] string query, [MarshalAs(UnmanagedType.I1)] bool forward, [MarshalAs(UnmanagedType.I1)] bool caseSensitive);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate uint EdReplaceAllFn(ulong id, [MarshalAs(UnmanagedType.LPUTF8Str)] string query, [MarshalAs(UnmanagedType.LPUTF8Str)] string repl, [MarshalAs(UnmanagedType.I1)] bool caseSensitive);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void EdCompleteFn(ulong id, uint prefixLen, [MarshalAs(UnmanagedType.LPUTF8Str)] string text);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void EdSetComplFn(ulong id, [MarshalAs(UnmanagedType.LPUTF8Str)] string items, uint selected);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void PopupShowFn([MarshalAs(UnmanagedType.LPUTF8Str)] string items, uint selected, uint scroll, float x, float y, float scale, float br, float bg, float bb, byte fr, byte fg, byte fb, byte dark);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void PopupHideFn();
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void PopupSigShowFn([MarshalAs(UnmanagedType.LPUTF8Str)] string line, uint activeStart, uint activeLen, float x, float y, float scale, float br, float bg, float bb, byte fr, byte fg, byte fb, byte dark);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void PopupSigHideFn();
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void PlayAgentDoneFn();
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void NotifyShowFn([MarshalAs(UnmanagedType.LPUTF8Str)] string title, [MarshalAs(UnmanagedType.LPUTF8Str)] string body, float scale, byte dark);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate void NotifyHideFn();

        private IntPtr _handle;

        private CreateFn _create; private CreateCommandFn _createCommand; private ExistsFn _exists; private IdFn _destroy; private ResizeFn _resize;
        // Restore-across-restart: seed+shell, seed-only (display-only/exited), the buffer dump, the cwd.
        private CreateSeededFn _createSeeded; private CreateDeadFn _createDead; private TitleFn _dump; private TitleFn _cwd;
        private SetScaleFn _setScale; private SetFontFn _setFont; private SetFontSizeFn _setFontSize;
        private SetColorsFn _setColors; private SetFocusFn _setFocus; private SendTextFn _sendText;
        private SendTextFn _setPreedit;
        private SendKeyFn _sendKey; private SendTextFn _paste; private IdFn _clear;
        private ScrollFn _scroll; private IdFn _render; private BoolFn _dirty; private BoolFn _present;
        private SelStartFn _selStart; private SelUpdateFn _selUpdate; private IdFn _selClear; private TitleFn _selText;
        private BoolFn _isAlive; private PtrFn _iosurface; private PtrFn _rawTexture;
        private SizeFn _size; private SizeFn _gridSize; private ScrollStateFn _scrollState; private CursorPxFn _cursorPx; private TitleFn _title;
        private McpSetToolsFn _mcpSetTools; private McpBufFn _mcpNextCall; private McpRespondFn _mcpRespond;
        private AvCreateFn _avCreate; private AvLoadFn _avLoad; private AvExistsFn _avExists; private AvVoidFn _avDestroy;
        private AvPollFn _avPoll; private AvVoidFn _avRender; private AvResizeFn _avResize; private AvThemeFn _avSetTheme; private AvFontsFn _avSetFonts;
        private AvPtrFn _avPanelTexture; private AvPtrFn _avInputTexture;
        private AvFloatFn _avContentHeight; private AvFloatFn _avInputHeight; private AvF1Fn _avSetScroll; private AvCaretFn _avCaret;
        private AvVoidFn _avInterrupt; private AvBufFn _avSessionId; private AvBufFn _avTitle;
        private AvBufFn _avTakeHostCommand; private AvTokenFn _avPanelTokenAt; private AvStampAtFn _avPanelStampAt;
        private FormatRelativeFn _formatRelative;
        private SessionsQueryFn _sessionsQuery; private SessionsPollFn _sessionsPoll; private SessionsGenFn _sessionsGen;
        private AvSetBrowsingFn _avSetBrowsing; private AvBrowseHoverFn _avBrowseHover;
        private AvVoidFn _avBrowseToggleArchived; private AvBrowseCountFn _avBrowseArchivedCount;
        private SessionsOpenElsewhereFn _sessionsOpenElsewhere;
        private AvStrFn _avSetPermissionMode; private AvBufFn _avPermissionMode;
        private AvStrFn _avSetModel; private AvBufFn _avModel; private AvBufFn _avModels;
        private AvBufFn _avCommands; private AvBufFn _avInputSlashPrefix; private EdCompleteFn _avInputComplete;
        private PopupShowFn _popupShowAbove;
        private AvUintGetFn _avQueueLen; private AvUintSetFn _avCancelQueued;
        private AvDownFn _avPanelDown; private AvDragFn _avPanelDrag; private AvScrollHFn _avPanelScrollH; private AvScrollHFn _avPanelScrollV;
        private AvVoidFn _avPanelSelectAll; private AvVoidFn _avPanelSelectClear; private AvBoolFn _avPanelHasSelection; private AvBufFn _avPanelSelectedText;
        private AvBoolFn _avThinking;
        private AvPollFn _avTakeAttention;
        private PlayAgentDoneFn _playAgentDone;
        private NotifyShowFn _notifyShow;
        private NotifyHideFn _notifyHide;
        private AvInputDownFn _avInputDown; private AvDragFn _avInputDrag; private AvInputKeyFn _avInputKey; private SetFocusFn _avSetFocus;
        private AvStrFn _avInputInsert; private AvStrFn _avInputSetPreedit; private AvVoidFn _avInputUndo; private AvVoidFn _avInputRedo; private AvVoidFn _avInputSelectAll;
        private AvBufFn _avInputCopy; private AvBufFn _avInputCut; private AvBufFn _avInputText;
        // Code editor view bindings (reusing several Av*/terminal delegate shapes).
        private EdCreateFn _edCreate; private AvExistsFn _edExists; private AvVoidFn _edDestroy; private ResizeFn _edResize;
        private SetScaleFn _edSetScale; private AvStrFn _edSetFont; private EdThemeFn _edSetTheme; private AvStrFn _edSetLanguage;
        private AvUintSetFn _edSetUndoLimit;
        // Git-diff gutter markers (optional: an older native bundle may lack them).
        private AvStrFn _edSetPath; private AvVoidFn _edRefreshDiff; private BoolFn _edPollDiff;
        // Markdown preview (optional: an older native bundle may lack them).
        private EdSetBoolFn _edSetPreview; private BoolFn _edPreviewActive; private AvTokenFn _edPreviewTokenAt;
        private AvVoidFn _edRender; private AvPtrFn _edRawTexture; private AvFloatFn _edContentHeight; private AvCaretFn _edCaret;
        private U64IdFn _edEditSerial;
        private AvInputKeyFn _edKey; private SetFocusFn _edSetFocus; private AvStrFn _edInsert; private AvStrFn _edSetPreedit; private AvStrFn _edSetText; private AvStrFn _edAddUsing;
        private AvBufFn _edText; private AvVoidFn _edUndo; private AvVoidFn _edRedo; private AvVoidFn _edSelectAll;
        private AvBufFn _edCopy; private AvBufFn _edCut; private EdMouseFn _edMouse; private EdHoverFn _edHover; private AvF1Fn _edScroll;
        private EdHunkAtFn _edHunkAt; private EdStageHunkFn _edHunkStaged; private EdStageHunkFn _edHunkHasStaged; private EdStageHunkFn _edHunkStagedOnly; private EdStageHunkFn _edStageHunk; private EdStageHunkFn _edUnstageHunk; private AvUintSetFn _edRevertHunk;
        private AvF1Fn _edSetScroll; private AvFloatFn _edScrollOffset; private AvF1Fn _edScrollH;
        private AvFloatFn _edGutterWidth; private EdLineAtYFn _edLineAtY; private AvUintSetFn _edToggleBp; private EdSetBpsFn _edSetBps; private EdSetBoolFn _edSetBpGutter;
        private AvVoidFn _edIndent, _edOutdent, _edToggleComment, _edMoveUp, _edMoveDown, _edDuplicate, _edDeleteLine;
        private AvUintSetFn _edGotoLine; private EdFindFn _edFind; private AvStrFn _edReplaceSel; private EdReplaceAllFn _edReplaceAll;
        private AvBufFn _edWordPrefix; private EdCompleteFn _edComplete; private EdSetComplFn _edSetCompletions; private AvUintGetFn _edCaretOffset;
        private PopupShowFn _popupShow; private PopupHideFn _popupHide;
        private PopupSigShowFn _popupSigShow; private PopupSigHideFn _popupSigHide;

        public bool IsLoaded => _handle != IntPtr.Zero;

        /// <summary>
        /// Bind to the native bundle Unity loaded as an editor plugin (same image
        /// on both platforms; <paramref name="bundlePath"/> is used only on macOS,
        /// where dlopen needs the resolved path). Unity keeps the plugin mapped
        /// across domain reloads, so the terminal registry persists and the window
        /// re-adopts its id after a reload.
        /// </summary>
        public void Load(string bundlePath)
        {
            if (IsLoaded) return;
#if UNITY_EDITOR_WIN
            // Bind to the SAME image Unity already loaded as an Editor/Windows
            // native plugin: a bare-name LoadLibrary resolves to the in-process
            // module by base name, so UnityPluginLoad — which captured the editor's
            // D3D device — ran in this very image, and the zero-copy surface uses
            // that device directly (no shadow copy, no cross-image device bridge).
            // Unity keeps editor plugins mapped across domain reloads, so the
            // terminal registry survives without our own shadow-copy trick.
            _handle = NativeOpen("unterm");
            if (_handle == IntPtr.Zero)
                throw new Exception(
                    $"native load failed — is unterm.dll imported as an Editor/Windows plugin? {NativeError()}");
#else
            // dlopen the bundle by its resolved path. dyld dedups by path, so if
            // Unity already auto-loaded it as an editor plugin — where
            // UnityPluginLoad ran and captured the editor's MTLDevice — we get THAT
            // same image and render on that device directly (no shadow copy, no
            // cross-image bridge); otherwise we load it here and the renderer falls
            // back to the default adapter. Either way we never dlclose on reload, so
            // the registry stays mapped and the window re-adopts its id. (Unlike
            // Windows' bare-name LoadLibrary, macOS dlopen needs the full path.)
            _handle = NativeOpen(bundlePath);
            if (_handle == IntPtr.Zero)
                throw new Exception($"native load failed (is unterm.dylib built?): {NativeError()}");
#endif

            _create = Sym<CreateFn>("unterm_create");
            _createCommand = Sym<CreateCommandFn>("unterm_create_command");
            _createSeeded = Sym<CreateSeededFn>("unterm_create_seeded");
            _createDead = Sym<CreateDeadFn>("unterm_create_dead");
            _dump = Sym<TitleFn>("unterm_dump");
            _cwd = Sym<TitleFn>("unterm_cwd");
            _exists = Sym<ExistsFn>("unterm_exists");
            _destroy = Sym<IdFn>("unterm_destroy");
            _resize = Sym<ResizeFn>("unterm_resize");
            _setScale = Sym<SetScaleFn>("unterm_set_scale");
            _setFont = Sym<SetFontFn>("unterm_set_font");
            _setFontSize = Sym<SetFontSizeFn>("unterm_set_font_size");
            _setColors = Sym<SetColorsFn>("unterm_set_colors");
            _setFocus = Sym<SetFocusFn>("unterm_set_focus");
            _sendText = Sym<SendTextFn>("unterm_send_text");
            _setPreedit = Sym<SendTextFn>("unterm_set_preedit");
            _sendKey = Sym<SendKeyFn>("unterm_send_key");
            _paste = Sym<SendTextFn>("unterm_paste");
            _clear = Sym<IdFn>("unterm_clear");
            _scroll = Sym<ScrollFn>("unterm_scroll");
            _selStart = Sym<SelStartFn>("unterm_selection_start");
            _selUpdate = Sym<SelUpdateFn>("unterm_selection_update");
            _selClear = Sym<IdFn>("unterm_selection_clear");
            _selText = Sym<TitleFn>("unterm_selection_text");
            _render = Sym<IdFn>("unterm_render");
            _dirty = Sym<BoolFn>("unterm_dirty");
            _present = Sym<BoolFn>("unterm_present");
            _isAlive = Sym<BoolFn>("unterm_is_alive");
            _iosurface = Sym<PtrFn>("unterm_iosurface");
            _rawTexture = Sym<PtrFn>("unterm_raw_texture");
            _size = Sym<SizeFn>("unterm_size");
            _gridSize = Sym<SizeFn>("unterm_grid_size");
            _scrollState = Sym<ScrollStateFn>("unterm_scroll_state");
            _cursorPx = Sym<CursorPxFn>("unterm_cursor_px");
            _title = Sym<TitleFn>("unterm_title");

            _mcpSetTools = Sym<McpSetToolsFn>("unterm_mcp_set_tools");
            _mcpNextCall = Sym<McpBufFn>("unterm_mcp_next_call");
            _mcpRespond = Sym<McpRespondFn>("unterm_mcp_respond");

            _avCreate = Sym<AvCreateFn>("unterm_agentview_create");
            _avLoad = Sym<AvLoadFn>("unterm_agentview_load");
            _avExists = Sym<AvExistsFn>("unterm_agentview_exists");
            _avDestroy = Sym<AvVoidFn>("unterm_agentview_destroy");
            _avPoll = Sym<AvPollFn>("unterm_agentview_poll");
            _avRender = Sym<AvVoidFn>("unterm_agentview_render");
            _avResize = Sym<AvResizeFn>("unterm_agentview_resize");
            _avSetTheme = Sym<AvThemeFn>("unterm_agentview_set_theme");
            _avSetFonts = Sym<AvFontsFn>("unterm_agentview_set_fonts");
            _avPanelTexture = Sym<AvPtrFn>("unterm_agentview_panel_texture");
            _avInputTexture = Sym<AvPtrFn>("unterm_agentview_input_texture");
            _avContentHeight = Sym<AvFloatFn>("unterm_agentview_content_height");
            _avInputHeight = Sym<AvFloatFn>("unterm_agentview_input_height");
            _avSetScroll = Sym<AvF1Fn>("unterm_agentview_set_scroll");
            _avCaret = Sym<AvCaretFn>("unterm_agentview_caret");
            _avInterrupt = Sym<AvVoidFn>("unterm_agentview_interrupt");
            _avSetPermissionMode = Sym<AvStrFn>("unterm_agentview_set_permission_mode");
            _avPermissionMode = Sym<AvBufFn>("unterm_agentview_permission_mode");
            _avSetModel = Sym<AvStrFn>("unterm_agentview_set_model");
            _avModel = Sym<AvBufFn>("unterm_agentview_model");
            _avModels = Sym<AvBufFn>("unterm_agentview_models");
            _avCommands = Sym<AvBufFn>("unterm_agentview_commands");
            _avInputSlashPrefix = Sym<AvBufFn>("unterm_agentview_input_slash_prefix");
            _avInputComplete = Sym<EdCompleteFn>("unterm_agentview_input_complete");
            _avQueueLen = Sym<AvUintGetFn>("unterm_agentview_queue_len");
            _avCancelQueued = Sym<AvUintSetFn>("unterm_agentview_cancel_queued");
            _avSessionId = Sym<AvBufFn>("unterm_agentview_session_id");
            _avTitle = Sym<AvBufFn>("unterm_agentview_title");
            _avTakeHostCommand = Sym<AvBufFn>("unterm_agentview_take_host_command");
            _avPanelTokenAt = Sym<AvTokenFn>("unterm_agentview_panel_token_at");
            _avPanelStampAt = Sym<AvStampAtFn>("unterm_agentview_panel_stamp_at");
            _formatRelative = Sym<FormatRelativeFn>("unterm_format_relative");
            _sessionsQuery = Sym<SessionsQueryFn>("unterm_sessions_query");
            _sessionsPoll = Sym<SessionsPollFn>("unterm_sessions_poll");
            _sessionsGen = Sym<SessionsGenFn>("unterm_sessions_generation");
            _avSetBrowsing = Sym<AvSetBrowsingFn>("unterm_agentview_set_browsing");
            _avBrowseHover = Sym<AvBrowseHoverFn>("unterm_agentview_browse_hover");
            _avBrowseToggleArchived = Sym<AvVoidFn>("unterm_agentview_browse_toggle_archived");
            _avBrowseArchivedCount = Sym<AvBrowseCountFn>("unterm_agentview_browse_archived_count");
            _sessionsOpenElsewhere = Sym<SessionsOpenElsewhereFn>("unterm_sessions_open_elsewhere");
            _avPanelDown = Sym<AvDownFn>("unterm_agentview_panel_down");
            _avPanelDrag = Sym<AvDragFn>("unterm_agentview_panel_drag");
            _avPanelScrollH = Sym<AvScrollHFn>("unterm_agentview_panel_scroll_h");
            _avPanelScrollV = Sym<AvScrollHFn>("unterm_agentview_panel_scroll_v");
            _avPanelSelectAll = Sym<AvVoidFn>("unterm_agentview_panel_select_all");
            _avPanelSelectClear = Sym<AvVoidFn>("unterm_agentview_panel_select_clear");
            _avPanelHasSelection = Sym<AvBoolFn>("unterm_agentview_panel_has_selection");
            _avThinking = Sym<AvBoolFn>("unterm_agentview_thinking");
            _avTakeAttention = Sym<AvPollFn>("unterm_agentview_take_attention");
            _playAgentDone = Sym<PlayAgentDoneFn>("unterm_play_agent_done");
            _notifyShow = Sym<NotifyShowFn>("unterm_notify_show");
            _notifyHide = Sym<NotifyHideFn>("unterm_notify_hide");
            _avPanelSelectedText = Sym<AvBufFn>("unterm_agentview_panel_selected_text");
            _avInputDown = Sym<AvInputDownFn>("unterm_agentview_input_down");
            _avInputDrag = Sym<AvDragFn>("unterm_agentview_input_drag");
            _avInputKey = Sym<AvInputKeyFn>("unterm_agentview_input_key");
            _avSetFocus = Sym<SetFocusFn>("unterm_agentview_set_focus");
            _avInputInsert = Sym<AvStrFn>("unterm_agentview_input_insert");
            _avInputSetPreedit = Sym<AvStrFn>("unterm_agentview_input_set_preedit");
            _avInputUndo = Sym<AvVoidFn>("unterm_agentview_input_undo");
            _avInputRedo = Sym<AvVoidFn>("unterm_agentview_input_redo");
            _avInputSelectAll = Sym<AvVoidFn>("unterm_agentview_input_select_all");
            _avInputCopy = Sym<AvBufFn>("unterm_agentview_input_copy");
            _avInputCut = Sym<AvBufFn>("unterm_agentview_input_cut");
            _avInputText = Sym<AvBufFn>("unterm_agentview_input_text");

            _edCreate = Sym<EdCreateFn>("unterm_editor_create");
            _edExists = Sym<AvExistsFn>("unterm_editor_exists");
            _edDestroy = Sym<AvVoidFn>("unterm_editor_destroy");
            _edResize = Sym<ResizeFn>("unterm_editor_resize");
            _edSetScale = Sym<SetScaleFn>("unterm_editor_set_scale");
            _edSetUndoLimit = Sym<AvUintSetFn>("unterm_editor_set_undo_limit");
            _edSetFont = Sym<AvStrFn>("unterm_editor_set_font");
            _edSetTheme = Sym<EdThemeFn>("unterm_editor_set_theme");
            _edSetLanguage = Sym<AvStrFn>("unterm_editor_set_language");
            _edSetPath = SymOpt<AvStrFn>("unterm_editor_set_path");
            _edRefreshDiff = SymOpt<AvVoidFn>("unterm_editor_refresh_diff");
            _edSetPreview = SymOpt<EdSetBoolFn>("unterm_editor_set_preview");
            _edPreviewActive = SymOpt<BoolFn>("unterm_editor_preview_active");
            _edPreviewTokenAt = SymOpt<AvTokenFn>("unterm_editor_preview_token_at");
            _edPollDiff = SymOpt<BoolFn>("unterm_editor_poll_diff");
            _edRender = Sym<AvVoidFn>("unterm_editor_render");
            _edRawTexture = Sym<AvPtrFn>("unterm_editor_raw_texture");
            _edContentHeight = Sym<AvFloatFn>("unterm_editor_content_height");
            _edEditSerial = Sym<U64IdFn>("unterm_editor_edit_serial");
            _edCaret = Sym<AvCaretFn>("unterm_editor_caret");
            _edKey = Sym<AvInputKeyFn>("unterm_editor_key");
            _edSetFocus = Sym<SetFocusFn>("unterm_editor_set_focus");
            _edInsert = Sym<AvStrFn>("unterm_editor_insert");
            _edSetPreedit = Sym<AvStrFn>("unterm_editor_set_preedit");
            _edSetText = Sym<AvStrFn>("unterm_editor_set_text");
            _edAddUsing = Sym<AvStrFn>("unterm_editor_add_using");
            _edText = Sym<AvBufFn>("unterm_editor_text");
            _edUndo = Sym<AvVoidFn>("unterm_editor_undo");
            _edRedo = Sym<AvVoidFn>("unterm_editor_redo");
            _edSelectAll = Sym<AvVoidFn>("unterm_editor_select_all");
            _edCopy = Sym<AvBufFn>("unterm_editor_copy");
            _edCut = Sym<AvBufFn>("unterm_editor_cut");
            _edMouse = Sym<EdMouseFn>("unterm_editor_mouse");
            _edHover = SymOpt<EdHoverFn>("unterm_editor_hover");
            _edHunkAt = SymOpt<EdHunkAtFn>("unterm_editor_hunk_at");
            _edHunkStaged = SymOpt<EdStageHunkFn>("unterm_editor_hunk_staged");
            _edHunkHasStaged = SymOpt<EdStageHunkFn>("unterm_editor_hunk_has_staged");
            _edHunkStagedOnly = SymOpt<EdStageHunkFn>("unterm_editor_hunk_staged_only");
            _edStageHunk = SymOpt<EdStageHunkFn>("unterm_editor_stage_hunk");
            _edUnstageHunk = SymOpt<EdStageHunkFn>("unterm_editor_unstage_hunk");
            _edRevertHunk = SymOpt<AvUintSetFn>("unterm_editor_revert_hunk");
            _edScroll = Sym<AvF1Fn>("unterm_editor_scroll");
            _edSetScroll = Sym<AvF1Fn>("unterm_editor_set_scroll");
            _edScrollOffset = Sym<AvFloatFn>("unterm_editor_scroll_offset");
            _edScrollH = Sym<AvF1Fn>("unterm_editor_scroll_h");
            // Optional: tolerate an older plugin .dylib that predates these symbols
            // (features stay disabled rather than breaking the whole editor at load).
            _edGutterWidth = SymOpt<AvFloatFn>("unterm_editor_gutter_width");
            _edLineAtY = SymOpt<EdLineAtYFn>("unterm_editor_line_at_y");
            _edToggleBp = SymOpt<AvUintSetFn>("unterm_editor_toggle_breakpoint");
            _edSetBps = SymOpt<EdSetBpsFn>("unterm_editor_set_breakpoints");
            _edSetBpGutter = SymOpt<EdSetBoolFn>("unterm_editor_set_bp_gutter");
            _edIndent = Sym<AvVoidFn>("unterm_editor_indent");
            _edOutdent = Sym<AvVoidFn>("unterm_editor_outdent");
            _edToggleComment = Sym<AvVoidFn>("unterm_editor_toggle_comment");
            _edMoveUp = Sym<AvVoidFn>("unterm_editor_move_line_up");
            _edMoveDown = Sym<AvVoidFn>("unterm_editor_move_line_down");
            _edDuplicate = Sym<AvVoidFn>("unterm_editor_duplicate_line");
            _edDeleteLine = Sym<AvVoidFn>("unterm_editor_delete_line");
            _edGotoLine = Sym<AvUintSetFn>("unterm_editor_goto_line");
            _edFind = Sym<EdFindFn>("unterm_editor_find");
            _edReplaceSel = Sym<AvStrFn>("unterm_editor_replace_selection");
            _edReplaceAll = Sym<EdReplaceAllFn>("unterm_editor_replace_all");
            _edWordPrefix = Sym<AvBufFn>("unterm_editor_word_prefix");
            _edComplete = Sym<EdCompleteFn>("unterm_editor_complete");
            _edSetCompletions = Sym<EdSetComplFn>("unterm_editor_set_completions");
            _edCaretOffset = Sym<AvUintGetFn>("unterm_editor_caret_offset");
            // Native completion popup is macOS-only for now; bind optionally so the
            // Windows bundle (no such symbols yet) still loads.
            _popupShow = SymOpt<PopupShowFn>("unterm_popup_show");
            _popupShowAbove = SymOpt<PopupShowFn>("unterm_popup_show_above");
            _popupHide = SymOpt<PopupHideFn>("unterm_popup_hide");
            _popupSigShow = SymOpt<PopupSigShowFn>("unterm_popup_sig_show");
            _popupSigHide = SymOpt<PopupSigHideFn>("unterm_popup_sig_hide");
        }

        private T Sym<T>(string name) where T : Delegate
        {
            var addr = NativeSym(_handle, name);
            if (addr == IntPtr.Zero)
                throw new Exception($"symbol '{name}' not found: {NativeError()}");
            return Marshal.GetDelegateForFunctionPointer<T>(addr);
        }

        private T SymOpt<T>(string name) where T : Delegate
        {
            var addr = NativeSym(_handle, name);
            return addr == IntPtr.Zero ? null : Marshal.GetDelegateForFunctionPointer<T>(addr);
        }

        private static string Utf8(IntPtr p, UIntPtr len) =>
            p == IntPtr.Zero ? string.Empty : Marshal.PtrToStringUTF8(p, (int)len.ToUInt64());

        public ulong Create(uint w, uint h, float scale, string cwd) => _create(w, h, scale, cwd ?? string.Empty);
        /// Create a terminal that launches `command` directly in the PTY (no shell prompt / typed input).
        public ulong CreateCommand(uint w, uint h, float scale, string cwd, string command) =>
            _createCommand(w, h, scale, cwd ?? string.Empty, command ?? string.Empty);
        /// Restore an interactive shell with the grid pre-seeded; re-claims terminal id `id` if free.
        public ulong CreateSeeded(ulong id, uint w, uint h, float scale, string cwd, string seed) =>
            _createSeeded(id, w, h, scale, cwd ?? string.Empty, seed ?? string.Empty);
        /// Restore a display-only terminal (no shell, marked exited); re-claims terminal id `id` if free.
        public ulong CreateDead(ulong id, uint w, uint h, float scale, string seed) =>
            _createDead(id, w, h, scale, seed ?? string.Empty);
        /// The full buffer (scrollback + screen) as truecolor-SGR text, for saving across a restart.
        public string Dump(ulong id)
        {
            var p = _dump(id, out UIntPtr len);
            return Utf8(p, len);
        }
        /// The shell's current working directory (empty if no live shell), for restoring cwd on resume.
        public string Cwd(ulong id)
        {
            var p = _cwd(id, out UIntPtr len);
            return Utf8(p, len);
        }
        public bool Exists(ulong id) => id != 0 && _exists(id);
        public void Destroy(ulong id) { if (id != 0) _destroy(id); }
        public void Resize(ulong id, uint w, uint h, float scale) => _resize(id, w, h, scale);
        public void SetScale(ulong id, float scale) => _setScale(id, scale);
        public void SetFont(ulong id, string path) => _setFont(id, path ?? string.Empty);
        public void SetFontSize(ulong id, float points) => _setFontSize(id, points);
        public void SetColors(ulong id, Color32 fg, Color32 bg, Color32 cursor) =>
            _setColors(id, Pack(fg), Pack(bg), Pack(cursor));
        public void SetFocus(ulong id, bool focused) => _setFocus(id, focused);
        public void SendText(ulong id, string text) { if (!string.IsNullOrEmpty(text)) _sendText(id, text); }
        // Empty string clears the composition, so always forward (don't short-circuit).
        public void SetPreedit(ulong id, string text) => _setPreedit(id, text ?? "");
        public void SendKey(ulong id, string name, bool ctrl, bool alt, bool shift) => _sendKey(id, name, ctrl, alt, shift);
        public void Paste(ulong id, string text) { if (!string.IsNullOrEmpty(text)) _paste(id, text); }
        public void Clear(ulong id) => _clear(id);
        public void Scroll(ulong id, int delta) => _scroll(id, delta);
        // mode: 0 = by character, 1 = by word (double-click), 2 = by line.
        public void SelectionStart(ulong id, float x, float y, byte mode) => _selStart(id, x, y, mode);
        public void SelectionUpdate(ulong id, float x, float y) => _selUpdate(id, x, y);
        public void SelectionClear(ulong id) => _selClear(id);
        public string SelectionText(ulong id)
        {
            var p = _selText(id, out UIntPtr len);
            return Utf8(p, len);
        }
        public void Render(ulong id) => _render(id);
        public bool Dirty(ulong id) => _dirty(id);
        // Advance the render-target swapchain; true if the displayed frame changed.
        public bool Present(ulong id) => _present(id);
        public bool IsAlive(ulong id) => _isAlive(id);
        public IntPtr IOSurface(ulong id) => _iosurface(id);
        public IntPtr RawTexture(ulong id) => _rawTexture(id);
        public void Size(ulong id, out uint w, out uint h) => _size(id, out w, out h);
        public void GridSize(ulong id, out uint cols, out uint rows) => _gridSize(id, out cols, out rows);
        // history = scrollback lines above the screen; offset = lines scrolled up
        // from the live bottom (0 = pinned); screen = visible row count.
        public void ScrollState(ulong id, out uint history, out uint offset, out uint screen) =>
            _scrollState(id, out history, out offset, out screen);
        public bool CursorPx(ulong id, out float x, out float y, out float w, out float h) =>
            _cursorPx(id, out x, out y, out w, out h);
        public string Title(ulong id)
        {
            var p = _title(id, out UIntPtr len);
            return Utf8(p, len);
        }

        // --- shared MCP server (editor-global, survives reloads) ---
        public void McpSetTools(string json) => _mcpSetTools(json ?? "[]");
        /// The next queued tool call as `{id,name,args}` JSON, or "" if none.
        public string McpNextCall()
        {
            var p = _mcpNextCall(out UIntPtr len);
            return Utf8(p, len);
        }
        public void McpRespond(ulong id, string resultJson) => _mcpRespond(id, resultJson ?? "{}");

        // --- agent view (id-based; owns session + transcript panel + input box) ---
        /// Start a new conversation rooted at `cwd`; returns the view id. Sizes are
        /// physical px: (panel w/h, input w/h).
        public ulong AgentviewCreate(string cwd, uint pw, uint ph, uint iw, uint ih, string effort, string claudeCmd) =>
            _avCreate(cwd ?? string.Empty, pw, ph, iw, ih, effort ?? string.Empty, claudeCmd ?? string.Empty);
        /// Resume a prior conversation `resume` (empty -> fresh); returns the view id.
        /// `effort` is the reasoning effort (none/low/medium/high/max; ""/default = model default).
        /// `claudeCmd` is the resolved absolute path to the managed `claude` CLI; ""
        /// is rejected (spawn fails) — Unterm never falls back to a system `claude`.
        public ulong AgentviewLoad(string cwd, string resume, uint pw, uint ph, uint iw, uint ih, string effort, string claudeCmd) =>
            _avLoad(cwd ?? string.Empty, resume ?? string.Empty, pw, ph, iw, ih, effort ?? string.Empty, claudeCmd ?? string.Empty);
        public bool AgentviewExists(ulong id) => id != 0 && _avExists(id);
        public void AgentviewDestroy(ulong id) { if (id != 0) _avDestroy(id); }
        /// bit0 = dirty (re-render + repaint), bit1 = animating (repaint only).
        public uint AgentviewPoll(ulong id) => _avPoll(id);
        public void AgentviewRender(ulong id) => _avRender(id);
        public void AgentviewResize(ulong id, uint pw, uint ph, uint iw, uint ih, float scale) =>
            _avResize(id, pw, ph, iw, ih, scale);
        public void AgentviewSetTheme(ulong id, Color bg, Color32 fg) =>
            _avSetTheme(id, bg.r, bg.g, bg.b, bg.a, fg.r, fg.g, fg.b);
        public void AgentviewSetFonts(ulong id, string regular, string bold, string italic, string boldItalic) =>
            _avSetFonts(id, regular ?? string.Empty, bold ?? string.Empty, italic ?? string.Empty, boldItalic ?? string.Empty);
        public IntPtr AgentviewPanelTexture(ulong id) => _avPanelTexture(id);
        public IntPtr AgentviewInputTexture(ulong id) => _avInputTexture(id);
        public float AgentviewContentHeight(ulong id) => _avContentHeight(id);
        public float AgentviewInputHeight(ulong id) => _avInputHeight(id);
        public void AgentviewSetScroll(ulong id, float scroll) => _avSetScroll(id, scroll);
        public void AgentviewCaret(ulong id, out float x, out float y, out float w, out float h) =>
            _avCaret(id, out x, out y, out w, out h);
        public void AgentviewInterrupt(ulong id) { if (id != 0) _avInterrupt(id); }
        /// Permission mode: "default" / "auto" / "plan" / "acceptEdits".
        public void AgentviewSetPermissionMode(ulong id, string mode) { if (id != 0) _avSetPermissionMode(id, mode ?? "default"); }
        public string AgentviewPermissionMode(ulong id) { var p = _avPermissionMode(id, out UIntPtr len); return Utf8(p, len); }
        /// Model alias ("opus"/"sonnet"/"haiku"), or "" / "default" for the engine default.
        public void AgentviewSetModel(ulong id, string model) { if (id != 0) _avSetModel(id, model ?? string.Empty); }
        /// Active model: the user's choice, else the resolved model from init.
        public string AgentviewModel(ulong id) { var p = _avModel(id, out UIntPtr len); return Utf8(p, len); }
        public string AgentviewModels(ulong id) { var p = _avModels(id, out UIntPtr len); return Utf8(p, len); }
        public string AgentviewCommands(ulong id) { var p = _avCommands(id, out UIntPtr len); return Utf8(p, len); }
        public string AgentviewInputSlashPrefix(ulong id) { var p = _avInputSlashPrefix(id, out UIntPtr len); return Utf8(p, len); }
        public void AgentviewInputComplete(ulong id, uint prefixLen, string text) { if (id != 0) _avInputComplete(id, prefixLen, text ?? ""); }
        /// Number of follow-up prompts waiting in the queue.
        public uint AgentviewQueueLen(ulong id) => id != 0 ? _avQueueLen(id) : 0u;
        /// Cancel the index-th queued follow-up prompt (0-based).
        public void AgentviewCancelQueued(ulong id, uint index) { if (id != 0) _avCancelQueued(id, index); }
        public string AgentviewSessionId(ulong id) { var p = _avSessionId(id, out UIntPtr len); return Utf8(p, len); }
        public string AgentviewTitle(ulong id) { var p = _avTitle(id, out UIntPtr len); return Utf8(p, len); }
        public string AgentviewTakeHostCommand(ulong id) { var p = _avTakeHostCommand(id, out UIntPtr len); return Utf8(p, len); }
        public string AgentviewPanelTokenAt(ulong id, float x, float y) { var p = _avPanelTokenAt(id, x, y, out UIntPtr len); return Utf8(p, len); }
        /// Unix stamp of the time separator under (x, y) in the transcript (0 = none).
        public ulong AgentviewPanelStampAt(ulong id, float x, float y) => _avPanelStampAt(id, x, y);
        /// Localized relative label ("5 minutes ago") for a unix-seconds stamp — the
        /// same formatting the transcript separators use.
        public string FormatRelative(ulong unixSecs) { var p = _formatRelative(unixSecs, out UIntPtr len); return Utf8(p, len); }
        /// Kick off an async session listing/search for `cwd` (limit 0 = all,
        /// query "" = list only); returns the serial to poll. Never blocks.
        public ulong SessionsQuery(string cwd, int limit, string query) =>
            _sessionsQuery(cwd ?? string.Empty, (UIntPtr)(ulong)Mathf.Max(0, limit), query ?? string.Empty);
        /// The JSON result for `serial` if ready (a `[{id,title,updated,snippet}]`
        /// array), else null while the worker is still computing.
        public string SessionsPoll(ulong serial)
        {
            var p = _sessionsPoll(serial, out UIntPtr len);
            return p == IntPtr.Zero ? null : Utf8(p, len);
        }
        /// Bumped when a session file appears/vanishes on disk; the host re-lists on change.
        public ulong SessionsGeneration() => _sessionsGen != null ? _sessionsGen() : 0;
        /// Enter/leave the native "All Sessions" browser: the panel texture shows
        /// the list and the composer becomes its search box.
        public void AgentviewSetBrowsing(ulong id, bool on) { if (id != 0) _avSetBrowsing(id, on ? (byte)1 : (byte)0); }
        /// Pointer motion over the browser list (physical px); true = hover changed.
        public bool AgentviewBrowseHover(ulong id, float x, float y) => id != 0 && _avBrowseHover(id, x, y) != 0;
        public void AgentviewBrowseToggleArchived(ulong id) { if (id != 0) _avBrowseToggleArchived(id); }
        public ulong AgentviewBrowseArchivedCount(ulong id) => id == 0 ? 0 : _avBrowseArchivedCount(id);
        /// Sessions open in other windows (newline-joined ids), greyed as non-resumable.
        /// Newline-joined session ids driven by a live `claude` process in `cwd`'s
        /// project (from Claude Code's session registry), for greying the picker.
        public string SessionsOpenElsewhere(string cwd)
        {
            var p = _sessionsOpenElsewhere(cwd ?? string.Empty, out UIntPtr len);
            return p == IntPtr.Zero ? string.Empty : Utf8(p, len);
        }
        /// Transcript mouse-down: resolves permission buttons AND begins selection
        /// internally. Returns 1 if consumed.
        public byte AgentviewPanelDown(ulong id, float x, float y) => _avPanelDown(id, x, y);
        public void AgentviewPanelDrag(ulong id, float x, float y) => _avPanelDrag(id, x, y);
        /// Horizontal scroll over a code block; returns 1 if consumed.
        public byte AgentviewPanelScrollH(ulong id, float x, float y, float dx) => _avPanelScrollH(id, x, y, dx);
        /// Vertical scroll over the capped plan box; returns 1 if consumed.
        public byte AgentviewPanelScrollV(ulong id, float x, float y, float dy) => _avPanelScrollV(id, x, y, dy);
        public void AgentviewPanelSelectAll(ulong id) => _avPanelSelectAll(id);
        public void AgentviewPanelSelectClear(ulong id) => _avPanelSelectClear(id);
        public bool AgentviewPanelHasSelection(ulong id) => _avPanelHasSelection(id);
        public bool AgentviewThinking(ulong id) => _avThinking != null && _avThinking(id);
        /// Drain the one-shot attention signal: 0 none, 1 turn done, 2 needs a decision.
        public uint AgentviewTakeAttention(ulong id) => _avTakeAttention != null ? _avTakeAttention(id) : 0;
        /// Play the bundled "agent done" chime (host gates on app-active/settings).
        public void PlayAgentDone() { if (_playAgentDone != null) _playAgentDone(); }
        /// Show the agent notification card, top-right of the screen (host gates as above).
        public void NotifyShow(string title, string body, float scale, bool dark) { if (_notifyShow != null) _notifyShow(title, body, scale, (byte)(dark ? 1 : 0)); }
        /// Hide the agent notification card (once the editor is foregrounded).
        public void NotifyHide() { if (_notifyHide != null) _notifyHide(); }
        public string AgentviewPanelSelectedText(ulong id) { var s = _avPanelSelectedText(id, out UIntPtr len); return Utf8(s, len); }
        /// Input mouse-down. kind: 0 click, 2 double, 3 triple. Returns 1 if the
        /// Send/Stop button was hit (action done; do NOT start a drag).
        public byte AgentviewInputDown(ulong id, float x, float y, byte kind) => _avInputDown(id, x, y, kind);
        public void AgentviewInputDrag(ulong id, float x, float y) => _avInputDrag(id, x, y);
        /// Enter sends, Shift+Enter newlines, the rest edits — all handled in Rust.
        public void AgentviewInputKey(ulong id, string name, bool ctrl, bool alt, bool shift) =>
            _avInputKey(id, name ?? string.Empty, ctrl, alt, shift);
        /// Host keyboard focus for the composer; hides the caret while unfocused.
        public void AgentviewSetFocus(ulong id, bool focused) => _avSetFocus(id, focused);
        public void AgentviewInputInsert(ulong id, string text) { if (!string.IsNullOrEmpty(text)) _avInputInsert(id, text); }
        public void AgentviewInputSetPreedit(ulong id, string text) => _avInputSetPreedit(id, text ?? "");
        public void AgentviewInputUndo(ulong id) => _avInputUndo(id);
        public void AgentviewInputRedo(ulong id) => _avInputRedo(id);
        public void AgentviewInputSelectAll(ulong id) => _avInputSelectAll(id);
        public string AgentviewInputCopy(ulong id) { var s = _avInputCopy(id, out UIntPtr len); return Utf8(s, len); }
        public string AgentviewInputCut(ulong id) { var s = _avInputCut(id, out UIntPtr len); return Utf8(s, len); }
        public string AgentviewInputText(ulong id) { var s = _avInputText(id, out UIntPtr len); return Utf8(s, len); }

        // --- code editor view (id-based; tree-sitter highlighting + gutter) ---
        public ulong EditorCreate(uint w, uint h, float scale) => _edCreate(w, h, scale);
        public bool EditorExists(ulong id) => id != 0 && _edExists(id);
        public void EditorDestroy(ulong id) { if (id != 0) _edDestroy(id); }
        public void EditorResize(ulong id, uint w, uint h, float scale) => _edResize(id, w, h, scale);
        public void EditorSetScale(ulong id, float scale) => _edSetScale(id, scale);
        public void EditorSetUndoLimit(ulong id, int limit) => _edSetUndoLimit(id, (uint)(limit < 0 ? 0 : limit));
        public void EditorSetFont(ulong id, string path) => _edSetFont(id, path ?? string.Empty);
        /// Background rgba + foreground rgb, and whether to use the dark highlight theme.
        public void EditorSetTheme(ulong id, Color bg, Color32 fg, bool dark) =>
            _edSetTheme(id, bg.r, bg.g, bg.b, bg.a, fg.r, fg.g, fg.b, dark);
        /// Tree-sitter language token (e.g. "cs"); empty/unknown = plain.
        public void EditorSetLanguage(ulong id, string token) => _edSetLanguage(id, token ?? string.Empty);
        /// Open file path for git-diff gutter markers (empty = clear); kicks a fetch.
        public void EditorSetPath(ulong id, string path) => _edSetPath?.Invoke(id, path ?? string.Empty);
        /// Re-fetch the git base for the diff markers (focus / after save).
        public void EditorRefreshDiff(ulong id) => _edRefreshDiff?.Invoke(id);
        /// Apply a finished background git fetch; true if new markers arrived (re-render).
        public bool EditorPollDiff(ulong id) => _edPollDiff?.Invoke(id) ?? false;
        /// Whether the native bundle supports Markdown preview (older bundles don't).
        public bool EditorPreviewSupported => _edSetPreview != null;
        /// Toggle Markdown-preview mode (render/texture/scroll/mouse/copy route to it).
        public void EditorSetPreview(ulong id, bool on) => _edSetPreview?.Invoke(id, on);
        /// Whether Markdown-preview mode is on.
        public bool EditorPreviewActive(ulong id) => _edPreviewActive?.Invoke(id) ?? false;
        /// The existing-file path token under (x,y) in preview mode (empty if none).
        public string EditorPreviewTokenAt(ulong id, float x, float y)
        {
            if (_edPreviewTokenAt == null) return string.Empty;
            var p = _edPreviewTokenAt(id, x, y, out UIntPtr len);
            return Utf8(p, len);
        }
        public void EditorRender(ulong id) => _edRender(id);
        public IntPtr EditorRawTexture(ulong id) => _edRawTexture(id);
        public float EditorContentHeight(ulong id) => _edContentHeight(id);
        public ulong EditorEditSerial(ulong id) => _edEditSerial(id);
        public void EditorCaret(ulong id, out float x, out float y, out float w, out float h) =>
            _edCaret(id, out x, out y, out w, out h);
        public void EditorKey(ulong id, string name, bool ctrl, bool alt, bool shift) =>
            _edKey(id, name ?? string.Empty, ctrl, alt, shift);
        /// Host keyboard focus for the code editor; hides the caret while unfocused.
        public void EditorSetFocus(ulong id, bool focused) => _edSetFocus(id, focused);
        public void EditorInsert(ulong id, string text) { if (!string.IsNullOrEmpty(text)) _edInsert(id, text); }
        public void EditorSetPreedit(ulong id, string text) => _edSetPreedit(id, text ?? "");
        public void EditorSetText(ulong id, string text) => _edSetText(id, text ?? string.Empty);
        public void EditorAddUsing(ulong id, string ns) => _edAddUsing(id, ns ?? string.Empty);
        public string EditorText(ulong id) { var p = _edText(id, out UIntPtr len); return Utf8(p, len); }
        public void EditorUndo(ulong id) => _edUndo(id);
        public void EditorRedo(ulong id) => _edRedo(id);
        public void EditorSelectAll(ulong id) => _edSelectAll(id);
        public string EditorCopy(ulong id) { var p = _edCopy(id, out UIntPtr len); return Utf8(p, len); }
        public string EditorCut(ulong id) { var p = _edCut(id, out UIntPtr len); return Utf8(p, len); }
        /// Mouse at physical px: kind 0 click, 1 drag, 2 double-click, 3 triple-click.
        public void EditorMouse(ulong id, float x, float y, byte kind) => _edMouse(id, x, y, kind);
        /// Pointer moved (no button): show/hide the diff-peek tooltip; true = re-render.
        public bool EditorHover(ulong id, float x, float y) => _edHover?.Invoke(id, x, y) ?? false;
        /// The git-diff hunk index a click at (x,y) targets (gutter lane), or -1.
        public int EditorHunkAt(ulong id, float x, float y) => _edHunkAt?.Invoke(id, x, y) ?? -1;
        /// Whether the hunk is already staged (menu shows Unstage instead of Stage).
        public bool EditorHunkStaged(ulong id, int hunk) => _edHunkStaged?.Invoke(id, (uint)hunk) ?? false;
        /// Whether any staged content overlaps the hunk (partially staged regions too).
        public bool EditorHunkHasStaged(ulong id, int hunk) => _edHunkHasStaged?.Invoke(id, (uint)hunk) ?? false;
        /// Staged-only (buffer already at HEAD): revert is a no-op, menu offers just Unstage.
        public bool EditorHunkStagedOnly(ulong id, int hunk) => _edHunkStagedOnly?.Invoke(id, (uint)hunk) ?? false;
        /// Stage hunk to the git index (like `git add -p`); true on success.
        public bool EditorStageHunk(ulong id, int hunk) => _edStageHunk?.Invoke(id, (uint)hunk) ?? false;
        /// Unstage hunk (like `git restore --staged -p`); true on success.
        public bool EditorUnstageHunk(ulong id, int hunk) => _edUnstageHunk?.Invoke(id, (uint)hunk) ?? false;
        /// Revert hunk to its git-base content (one undoable buffer edit).
        public void EditorRevertHunk(ulong id, int hunk) => _edRevertHunk?.Invoke(id, (uint)hunk);
        public void EditorScroll(ulong id, float dy) => _edScroll(id, dy);
        public void EditorScrollH(ulong id, float dx) => _edScrollH(id, dx);
        public void EditorSetScroll(ulong id, float px) => _edSetScroll(id, px);
        public float EditorScrollOffset(ulong id) => _edScrollOffset(id);
        public float EditorGutterWidth(ulong id) => _edGutterWidth != null ? _edGutterWidth(id) : 0f;
        public uint EditorLineAtY(ulong id, float y) => _edLineAtY != null ? _edLineAtY(id, y) : 0u;
        public void EditorToggleBreakpoint(ulong id, uint line) => _edToggleBp?.Invoke(id, line);
        public void EditorSetBpGutter(ulong id, bool on) => _edSetBpGutter?.Invoke(id, on);
        public void EditorSetBreakpoints(ulong id, uint[] lines)
        {
            if (_edSetBps == null) return;
            if (lines == null || lines.Length == 0) { _edSetBps(id, IntPtr.Zero, UIntPtr.Zero); return; }
            var h = GCHandle.Alloc(lines, GCHandleType.Pinned);
            try { _edSetBps(id, h.AddrOfPinnedObject(), (UIntPtr)lines.Length); }
            finally { h.Free(); }
        }
        public void EditorIndent(ulong id) => _edIndent(id);
        public void EditorOutdent(ulong id) => _edOutdent(id);
        public void EditorToggleComment(ulong id) => _edToggleComment(id);
        public void EditorMoveLineUp(ulong id) => _edMoveUp(id);
        public void EditorMoveLineDown(ulong id) => _edMoveDown(id);
        public void EditorDuplicateLine(ulong id) => _edDuplicate(id);
        public void EditorDeleteLine(ulong id) => _edDeleteLine(id);
        public void EditorGotoLine(ulong id, uint line) => _edGotoLine(id, line);
        public bool EditorFind(ulong id, string query, bool forward, bool caseSensitive) => _edFind(id, query ?? "", forward, caseSensitive);
        public void EditorReplaceSelection(ulong id, string repl) => _edReplaceSel(id, repl ?? "");
        public uint EditorReplaceAll(ulong id, string query, string repl, bool caseSensitive) => _edReplaceAll(id, query ?? "", repl ?? "", caseSensitive);
        /// The identifier prefix immediately before the caret (for autocomplete).
        public string EditorWordPrefix(ulong id) { var p = _edWordPrefix(id, out UIntPtr len); return Utf8(p, len); }
        /// Accept a completion: replace `prefixLen` chars before the caret with `text`.
        public void EditorComplete(ulong id, uint prefixLen, string text) => _edComplete(id, prefixLen, text ?? "");
        /// Set the autocomplete popup items ('\n'-joined; empty hides it) + selection.
        public void EditorSetCompletions(ulong id, string items, uint selected) => _edSetCompletions(id, items ?? "", selected);
        /// Show the native completion popup (a non-activating NSPanel) at screen point
        /// (x,y) in POINTS, top-left origin. No-op where unbound (non-macOS).
        public bool PopupAvailable => _popupShow != null;
        public void PopupShow(string items, uint selected, uint scroll, float x, float y, float scale, Color bg, Color32 fg, bool dark) =>
            _popupShow?.Invoke(items ?? "", selected, scroll, x, y, scale, bg.r, bg.g, bg.b, fg.r, fg.g, fg.b, (byte)(dark ? 1 : 0));
        public void PopupShowAbove(string items, uint selected, uint scroll, float x, float y, float scale, Color bg, Color32 fg, bool dark) =>
            _popupShowAbove?.Invoke(items ?? "", selected, scroll, x, y, scale, bg.r, bg.g, bg.b, fg.r, fg.g, fg.b, (byte)(dark ? 1 : 0));
        public void PopupHide() => _popupHide?.Invoke();
        public bool PopupSigAvailable => _popupSigShow != null;
        public void PopupSigShow(string line, uint activeStart, uint activeLen, float x, float y, float scale, Color bg, Color32 fg, bool dark) =>
            _popupSigShow?.Invoke(line ?? "", activeStart, activeLen, x, y, scale, bg.r, bg.g, bg.b, fg.r, fg.g, fg.b, (byte)(dark ? 1 : 0));
        public void PopupSigHide() => _popupSigHide?.Invoke();
        /// The caret's absolute character offset in the document (for semantic completion).
        public int EditorCaretOffset(ulong id) => (int)_edCaretOffset(id);

        private static uint Pack(Color32 c) => (uint)((c.r << 16) | (c.g << 8) | c.b);

        public void Dispose()
        {
            if (_handle != IntPtr.Zero)
            {
                // Best-effort: the OS keeps the image mapped while other (leaked)
                // refs from prior reloads or sibling windows remain — intended,
                // the native globals must outlive any single managed wrapper.
                NativeClose(_handle);
                _handle = IntPtr.Zero;
            }
            _create = null; _createCommand = null; _createSeeded = null; _createDead = null; _dump = null; _cwd = null;
            _exists = null; _destroy = null; _resize = null; _setScale = null;
            _setFont = null; _setFontSize = null; _setColors = null; _setFocus = null;
            _sendText = null; _sendKey = null; _scroll = null; _render = null; _dirty = null; _present = null;
            _selStart = null; _selUpdate = null; _selClear = null; _selText = null;
            _isAlive = null; _iosurface = null; _rawTexture = null;
            _paste = null; _clear = null;
            _size = null; _gridSize = null; _scrollState = null; _cursorPx = null; _title = null;
            _mcpSetTools = null; _mcpNextCall = null; _mcpRespond = null;
            _avCreate = null; _avLoad = null; _avExists = null; _avDestroy = null;
            _avPoll = null; _avRender = null; _avResize = null; _avSetTheme = null; _avSetFonts = null;
            _avPanelTexture = null; _avInputTexture = null;
            _avContentHeight = null; _avInputHeight = null; _avSetScroll = null; _avCaret = null;
            _avInterrupt = null; _avSessionId = null; _avTitle = null; _avTakeHostCommand = null; _avPanelTokenAt = null;
            _avPanelStampAt = null; _formatRelative = null; _sessionsQuery = null; _sessionsPoll = null; _sessionsGen = null;
            _avSetBrowsing = null; _avBrowseHover = null; _avBrowseToggleArchived = null; _avBrowseArchivedCount = null; _sessionsOpenElsewhere = null;
            _avSetPermissionMode = null; _avPermissionMode = null; _avSetModel = null; _avModel = null;
            _avModels = null; _avCommands = null; _avInputSlashPrefix = null; _avInputComplete = null; _popupShowAbove = null;
            _avQueueLen = null; _avCancelQueued = null;
            _avPanelDown = null; _avPanelDrag = null; _avPanelScrollH = null; _avPanelScrollV = null;
            _avPanelSelectAll = null; _avPanelSelectClear = null; _avPanelHasSelection = null; _avPanelSelectedText = null;
            _avThinking = null;
            _avTakeAttention = null;
            _playAgentDone = null;
            _notifyShow = null;
            _notifyHide = null;
            _avInputDown = null; _avInputDrag = null; _avInputKey = null; _avSetFocus = null;
            _avInputInsert = null; _avInputSetPreedit = null; _avInputUndo = null; _avInputRedo = null; _avInputSelectAll = null;
            _avInputCopy = null; _avInputCut = null; _avInputText = null;
            _edCreate = null; _edExists = null; _edDestroy = null; _edResize = null; _edSetScale = null; _edSetUndoLimit = null;
            _edSetFont = null; _edSetTheme = null; _edSetLanguage = null; _edRender = null; _edRawTexture = null;
            _edSetPath = null; _edRefreshDiff = null; _edPollDiff = null;
            _edSetPreview = null; _edPreviewActive = null; _edPreviewTokenAt = null;
            _edContentHeight = null; _edEditSerial = null; _edCaret = null; _edKey = null; _edSetFocus = null; _edInsert = null; _edSetPreedit = null;
            _edSetText = null; _edAddUsing = null; _edText = null; _edUndo = null; _edRedo = null; _edSelectAll = null;
            _edCopy = null; _edCut = null; _edMouse = null; _edHover = null; _edScroll = null;
            _edHunkAt = null; _edHunkStaged = null; _edHunkHasStaged = null; _edHunkStagedOnly = null; _edStageHunk = null; _edUnstageHunk = null; _edRevertHunk = null;
            _edSetScroll = null; _edScrollOffset = null; _edScrollH = null; _edIndent = null; _edOutdent = null;
            _edGutterWidth = null; _edLineAtY = null; _edToggleBp = null; _edSetBps = null;
            _edToggleComment = null; _edMoveUp = null; _edMoveDown = null; _edDuplicate = null;
            _edDeleteLine = null; _edGotoLine = null; _edFind = null; _edReplaceSel = null; _edReplaceAll = null;
            _edWordPrefix = null; _edComplete = null; _edSetCompletions = null; _edCaretOffset = null;
        }
    }
}
