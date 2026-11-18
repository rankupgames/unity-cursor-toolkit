using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Unterm.Editor
{
    /// <summary>
    /// User preferences for the agent panel (persisted in <see cref="EditorPrefs"/>).
    /// </summary>
    internal static class UntermAgentPrefs
    {
        private const string NotifySoundKey = "Unterm.Agent.NotifySound";

        /// Chime + OS notification when a turn finishes or a permission is raised
        /// while the Editor is backgrounded. On by default.
        public static bool NotifySoundEnabled
        {
            get => EditorPrefs.GetBool(NotifySoundKey, true);
            set => EditorPrefs.SetBool(NotifySoundKey, value);
        }
    }

    /// <summary>
    /// The Claude Code agent panel. A single native "AgentView" object (see the
    /// `agentview` module) owns the agent session, the transcript panel, and the
    /// input composer; this <see cref="EditorWindow"/> is a thin host that only
    /// lays the view out, paces per-frame rendering, blits its textures, forwards
    /// raw input, drives the OS clipboard + hidden IME field, and manages the
    /// session picker / persistence.
    ///
    /// The view lives in a process-global registry on the native side, so it
    /// (together with the loaded image and the editor-global MCP server,
    /// <see cref="UntermMcp"/>) survives C# domain reloads. This window re-adopts
    /// the view by id after a reload and only tears it down when the window
    /// actually closes. The header dropdown lists this project's past conversations
    /// straight from Claude Code's own on-disk storage (listed async by the native
    /// <c>sessions</c> worker) so any can be resumed, and an "All Sessions…" entry
    /// replaces the transcript with a searchable list over the full set; opening a
    /// window from the menu always starts a fresh one.
    /// </summary>
    public sealed class UntermAgentWindow : EditorWindow
    {
        private const float HeaderHeight = 22f;
        private const float InputHeight = 30f;
        private const float ScrollbarWidth = 13f;
        private const string InputControl = "UntermAgentInput";

        // IME: a hidden IMGUI field at the caret drives composition + plain typing;
        // committed text is flushed into the native input box each Repaint.
        private string _imeBuffer = "";
        private string _lastPreedit = ""; // last composition pushed to the editor
        private bool _composing;
        private bool _prevComposing;
        private bool _composeJustEnded;
        private bool _refocus;
        // The (global, single-slot) notification card's live state. Static because the
        // card is one screen-level window shared by every agent window.
        private static bool s_cardUp;
        private static string s_cardTitle;
        private static string s_cardBody;
        private static float s_cardScale;
        private static bool s_cardDark;
        private static double s_cardShownAt;
        // Keep re-rendering the card for this long after it's raised: the window is
        // ordered in while the editor is backgrounded, so the compositor can report
        // the very first frame occluded and the reveal is skipped — repainting a few
        // frames replaces it with a presented one. Also the minimum time it stays up
        // once the editor is foregrounded again, so a quick return still shows it.
        private const double NotifyRepaintFor = 0.7;
        private const double NotifyMinShow = 2.5;
        private GUIStyle _imeStyle;
        private GUIStyle _imeHidden; // transparent style so the IME field stays at the caret unseen
        private Texture2D _imeBgTex;

        private UntermNative _native;
        private string _status = "";

        // The AgentView lives in the native plugin (survives domain reloads),
        // referenced by a stable id we serialize and re-adopt.
        [SerializeField] private long _viewId;
        private static bool s_reloading;
        private ulong Vid => (ulong)_viewId;
        // The conversation's Claude session id once established (empty until then).
        // Serialized so a domain reload re-adopts and re-registers it as open.
        [SerializeField] private string _claudeSessionId = "";

        // Per-window agent settings, persisted across domain reloads. Permission
        // mode and model are pushed to the engine at runtime (control_requests).
        // Reasoning effort is a spawn-time CLI flag (--effort), so it's passed when
        // (re)creating the view and changing it respawns claude (resuming to keep
        // context). (Empty model = engine default; empty effort = model default.)
        [SerializeField] private string _permissionMode = "default";
        [SerializeField] private string _modelSelection = "";
        [SerializeField] private string _effort = "";

        // Set when we launch /login (or /logout) in a terminal; consumed on the
        // next OnFocus to rebuild the session with the new credentials. Serialized
        // so it survives a domain reload that happens while the user is logging in.
        [SerializeField] private bool _reconnectPending;

        private static readonly string[] s_modes =
            { "default", "auto", "plan", "acceptEdits" };

        // Session ids currently driven by a live `claude` process — this window's,
        // another Unterm window's, or an external CLI — from Claude Code's own
        // session registry (via the native side), so the picker greys out any
        // session already open somewhere and two processes never drive the same
        // conversation. Cached and refreshed at most ~once a second.
        private HashSet<string> _busyIds = new HashSet<string>();
        private double _busyIdsAt;

        // The registry-backed busy set for the dropdown (the native browser reads
        // the registry itself). Throttled so opening the menu doesn't re-scan hot.
        private HashSet<string> BusyIds()
        {
            if (_native != null && EditorApplication.timeSinceStartup - _busyIdsAt > 1.0)
            {
                _busyIdsAt = EditorApplication.timeSinceStartup;
                var joined = _native.SessionsOpenElsewhere(ProjectRoot);
                _busyIds = new HashSet<string>(
                    (joined ?? "").Split('\n'), StringComparer.Ordinal);
                _busyIds.Remove("");
            }
            return _busyIds;
        }

        // Transcript panel texture (zero-copy wrap of the native MTLTexture).
        private Texture2D _tex;
        private readonly Dictionary<IntPtr, Texture2D> _panelTextures =
            new Dictionary<IntPtr, Texture2D>();
        private int _panelTextureW, _panelTextureH;

        // Input strip texture (the native input box renders the field AND the
        // Send/Stop button into this one surface).
        private Texture2D _inputTex;
        private readonly Dictionary<IntPtr, Texture2D> _inputTextures =
            new Dictionary<IntPtr, Texture2D>();
        private int _inputTextureW, _inputTextureH;
        private float _inputHeight = InputHeight; // logical px, grows with content

        private float _scroll; // physical px, 0 = latest
        private bool _selecting;       // dragging a transcript selection
        private ulong _hoverStamp;     // unix stamp of the hovered time separator (0 = none)
        private bool _inputDragging;   // dragging an input-box selection

        // Recent sessions for the header picker, listed async from Claude Code's
        // own storage (no local index). Refreshed on focus / menu-open; _recentSerial
        // != 0 while a listing is in flight (drained in OnEditorUpdate).
        private UntermSessionInfo[] _recent = Array.Empty<UntermSessionInfo>();
        private ulong _recentSerial;
        private ulong _sessionsGen; // last sessions-dir generation the recent list reflects
        private const int RecentCount = 10;

        // "All Sessions" browser: natively rendered in place of the transcript
        // (the panel texture becomes the list; the composer becomes its search
        // box). This class only tracks the mode and moves the input strip to the
        // top — list drawing, search, hover and archiving all live in Rust.
        private bool _browsing;
        private float _stashScroll; // transcript scroll to restore on exit

        // Opened from the "Window/Unterm/Claude Code" menu (registered, and gated
        // on the CLI being installed, by ClaudeCode).
        public static void Open()
        {
            // A fresh window each time (CreateWindow, not the singleton GetWindow)
            // so several Claude Code conversations can run side by side; each gets
            // its own native AgentView and starts a new session. Cascade off the
            // focused one so new windows don't stack exactly on top.
            var from = focusedWindow as UntermAgentWindow;
            var w = CreateWindow<UntermAgentWindow>();
            w.titleContent = UntermWindowTitle.Create("Claude Code", UntermWindowTitle.AgentIcon, w.titleContent);
            w.minSize = new Vector2(320, 200);

            Vector2 size = from != null ? from.position.size : new Vector2(420f, 520f);
            Vector2 origin = from != null
                ? from.position.position + new Vector2(30f, 30f)
                : new Vector2(140f, 140f);
            if (origin.x > 900f || origin.y > 600f) origin = new Vector2(140f, 140f);
            w.position = new Rect(origin, size);

            w.Show();
            w.Focus();
        }

        private static string ProjectRoot =>
            Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;

        private void OnEnable()
        {
            wantsMouseMove = true; // hover on transcript time separators
            s_reloading = false;
            AssemblyReloadEvents.beforeAssemblyReload += OnBeforeReload;
            EditorApplication.update += OnEditorUpdate;
            LoadNative();
        }

        private void OnFocus()
        {
            _refocus = true; // re-park the IME field on the caret for typing
            if (_native != null && _viewId != 0) { _native.AgentviewSetFocus(Vid, true); RenderView(measureInput: false); Repaint(); }
#if UNITY_EDITOR_WIN
            // The Windows editor doesn't auto-engage the OS IME for a custom IMGUI
            // window (Auto leaves it off here), so Japanese/CJK composition never
            // starts. Force it on while we're focused; restored on blur.
            Input.imeCompositionMode = IMECompositionMode.On;
#endif
            // Returning to the panel after launching /login in a terminal: rebuild
            // the session so a fresh `claude` picks up the new credentials. Only
            // when no conversation was established yet (the not-signed-in case), so
            // a live transcript is never discarded.
            if (_reconnectPending)
            {
                _reconnectPending = false;
                if (_native != null && _viewId != 0 && string.IsNullOrEmpty(_claudeSessionId))
                    RecreateView();
            }
            RefreshRecent();
        }

        // Kick off (async) a refresh of the recent-sessions list backing the picker
        // dropdown, so the next time it opens it's current. Drained in OnEditorUpdate.
        private void RefreshRecent()
        {
            if (_native != null) _recentSerial = _native.SessionsQuery(ProjectRoot, RecentCount, "");
        }

        // Switch the transcript area to the native "All Sessions" browser.
        private void EnterBrowse()
        {
            if (_native == null || _viewId == 0 || _browsing) return;
            _browsing = true;
            _stashScroll = _scroll;
            _scroll = 0f; // the browser list is top-anchored
            _native.AgentviewSetBrowsing(Vid, true);
            _refocus = true; // park the IME field so search typing works right away
            RenderView();
            Repaint();
        }

        private void ExitBrowse()
        {
            if (!_browsing) return;
            _browsing = false;
            if (_native != null && _viewId != 0) _native.AgentviewSetBrowsing(Vid, false);
            _scroll = _stashScroll;
            RenderView();
            Repaint();
        }

        private void OnLostFocus()
        {
            // The `/`-completion popup is a separate OS window — dismiss it when this
            // window loses focus so it doesn't linger over other editors.
            CloseSlash();
            if (_native != null && _viewId != 0) { _native.AgentviewSetFocus(Vid, false); RenderView(measureInput: false); Repaint(); }
#if UNITY_EDITOR_WIN
            Input.imeCompositionMode = IMECompositionMode.Auto;
#endif
        }

        private void OnDisable()
        {
            CloseSlash();
            AssemblyReloadEvents.beforeAssemblyReload -= OnBeforeReload;
            EditorApplication.update -= OnEditorUpdate;
            // On a domain reload keep the native view (and the loaded image) alive
            // so the conversation survives the recompile; only tear it all down
            // when the window is actually closing.
            Teardown(keepView: s_reloading);
        }

        private static void OnBeforeReload() => s_reloading = true;

        // Poll the view off the editor tick; the native side owns transcript /
        // status / animation, so we just react to its dirty/animating flags and
        // mirror the session-id into the picker index. (MCP tool calls are drained
        // globally by UntermMcp, not here.)
        private void OnEditorUpdate()
        {
            if (_native == null || _viewId == 0) return;

            uint f = _native.AgentviewPoll(Vid);
            bool dirty = (f & 1) != 0;
            if (dirty) { RenderView(measureInput: false); Repaint(); }
            else if ((f & 2) != 0) Repaint();

            // The session started needing the user (turn finished, or it's waiting
            // on a permission/decision). Chime + show a notification card top-right —
            // but only while the Unity Editor is in the background: when it's the
            // active app the user is already here and will see it, so stay silent and
            // dismiss any card a background turn raised. Each window drains its own
            // signal, so the card names the session that raised it.
            uint attn = _native.AgentviewTakeAttention(Vid);
            bool appActive = UnityEditorInternal.InternalEditorUtility.isApplicationActive;
            if (attn != 0 && UntermAgentPrefs.NotifySoundEnabled && !appActive)
            {
                _native.PlayAgentDone();
                string title = titleContent != null && !string.IsNullOrEmpty(titleContent.text)
                    ? titleContent.text : "Claude Code";
                // Name the project so it's clear which editor/session it's from — a
                // single-slot card can't coordinate across Unity processes, so each
                // card self-identifies instead of trying to stack.
                string status = attn == 2 ? "Waiting for your response" : "Finished responding";
                string project = System.IO.Path.GetFileName(ProjectRoot);
                s_cardTitle = title;
                s_cardBody = string.IsNullOrEmpty(project) ? status : project + " · " + status;
                s_cardScale = EditorGUIUtility.pixelsPerPoint;
                s_cardDark = EditorGUIUtility.isProSkin;
                s_cardUp = true;
                s_cardShownAt = EditorApplication.timeSinceStartup;
                _native.NotifyShow(s_cardTitle, s_cardBody, s_cardScale, s_cardDark);
            }
            else if (s_cardUp)
            {
                double age = EditorApplication.timeSinceStartup - s_cardShownAt;
                if (appActive && age >= NotifyMinShow)
                {
                    _native.NotifyHide();
                    s_cardUp = false;
                }
                else if (!appActive && age < NotifyRepaintFor)
                {
                    // Repaint the freshly-raised card so a first frame reported
                    // occluded (window just ordered in while backgrounded) is
                    // replaced by a presented one — otherwise it stays invisible.
                    _native.NotifyShow(s_cardTitle, s_cardBody, s_cardScale, s_cardDark);
                }
            }

            // A built-in command the agent panel can't run over stream-json — it
            // needs a real TTY (/login's OAuth/browser flow). Launch it in an
            // interactive terminal; refocusing this window then reconnects. Gated
            // on the poll bit so the string only marshals when one is pending.
            if ((f & 4) != 0)
            {
                string hostCmd = _native.AgentviewTakeHostCommand(Vid);
                if (!string.IsNullOrEmpty(hostCmd)) RunHostCommand(hostCmd);
            }

            // The poll reports permission-mode / session-id changes as a flag bit,
            // so the strings are only marshaled on ticks they actually changed
            // (they used to allocate two fresh strings every idle tick).
            if ((f & 8) != 0)
            {
                // Keep the mode dropdown in sync with the engine: approving
                // ExitPlanMode switches the permission mode native-side, so mirror
                // it back here. (At attach the flow is the reverse —
                // ApplyAgentSettings pushes this window's persisted mode down.)
                string nativeMode = _native.AgentviewPermissionMode(Vid);
                if (!string.IsNullOrEmpty(nativeMode) && nativeMode != _permissionMode)
                {
                    _permissionMode = nativeMode;
                    Repaint();
                }

                // Record the Claude session id once established. The transcripts are
                // Claude Code's own storage; the picker lists them directly, and "open
                // elsewhere" greying comes from Claude Code's session registry (which
                // includes this window's own `claude` process), not a local set.
                string sid = _native.AgentviewSessionId(Vid);
                if (!string.IsNullOrEmpty(sid) && sid != _claudeSessionId)
                    _claudeSessionId = sid;
            }

            // Keep the tab title following the conversation's live (ai-)title — the
            // native side regenerates it as the chat grows, so gating this on the id
            // first appearing (or a one-shot SwitchTo) left it stale. A title change
            // always raises the dirty flag, so only marshal the string on dirty ticks
            // instead of allocating one every tick. Only adopt a non-empty title, so
            // the picker title SwitchTo set optimistically isn't clobbered during the
            // brief gap before the native title is read.
            if (dirty)
            {
                string agent = _native.AgentviewTitle(Vid);
                if (!string.IsNullOrEmpty(agent) && titleContent.text != agent)
                    titleContent = UntermWindowTitle.Create(agent, UntermWindowTitle.AgentIcon, titleContent);
            }

            // Drain any in-flight recent-sessions listing (for the picker dropdown).
            // (The "All Sessions" browser polls its own listing natively.)
            if (_recentSerial != 0)
            {
                string json = _native.SessionsPoll(_recentSerial);
                if (json != null) { _recent = UntermSessionJson.Parse(json); _recentSerial = 0; }
            }

            // A session appeared/vanished on disk (e.g. a `claude` CLI in the same
            // project): refresh the recent list so the dropdown stays current. The
            // browser watches the same generation natively.
            ulong gen = _native.SessionsGeneration();
            if (gen != _sessionsGen)
            {
                _sessionsGen = gen;
                RefreshRecent();
            }
        }

        // Handle a command the native side hands up. `resume` (from the session
        // browser: the host owns view lifetimes, so opening a row comes through
        // here) switches this window's conversation; anything else is a built-in
        // CLI command (/login, /logout) run in a real interactive terminal — the
        // stream-json session can't do the OAuth/browser flow, so shell out to
        // the same `claude` binary the agent uses (resolved by ClaudeCode).
        // Refocusing this window afterwards reconnects.
        private void RunHostCommand(string hostCmd)
        {
            // "resume<US>id<US>title" (US = 0x1F, the native field separator).
            // SwitchTo leaves the browser either way: picking the open session
            // exits it in place; anything else replaces the whole native view.
            if (hostCmd.StartsWith("resume\x1f"))
            {
                var parts = hostCmd.Split('\x1f');
                if (parts.Length >= 2) SwitchTo(parts[1], parts.Length >= 3 ? parts[2] : null);
                return;
            }
#if UNITY_EDITOR_OSX || UNITY_EDITOR_WIN
            string verb = hostCmd.StartsWith("/") ? hostCmd.Substring(1) : hostCmd;
            string claude = ClaudeCode.ClaudePath;
            if (string.IsNullOrEmpty(claude)) claude = "claude";

            // Quote the path (it may contain spaces under the user profile dir).
#if UNITY_EDITOR_WIN
            // PowerShell needs the call operator to run a quoted path; '' escapes '.
            string command = "& '" + claude.Replace("'", "''") + "' " + verb;
#else
            // Embedded in the shell's double-quoted `exec "..."`; '\'' escapes '.
            string command = "'" + claude.Replace("'", "'\\''") + "' " + verb;
#endif
            string title = verb == "logout" ? "Claude Logout" : "Claude Login";
            UntermWindow.CreateRunning(title, command);
            _reconnectPending = true;
#endif
        }

        // Destroy the current (dead) native view and start a fresh session, so a
        // new `claude` process initializes with the latest credentials.
        private void RecreateView()
        {
            try
            {
                var (pw, ph) = CurrentPanelSize();
                var (iw, ih) = CurrentInputSize();
                ulong old = Vid;
                // Create the replacement before destroying the old one, so a failed
                // create leaves the existing view intact.
                _viewId = (long)_native.AgentviewCreate(ProjectRoot, pw, ph, iw, ih, _effort, ClaudeCode.ClaudePath);
                if (old != 0 && old != Vid) _native.AgentviewDestroy(old);
                ApplyFonts();
                ApplyAgentSettings();
                _refocus = true;
                RenderView();
                Repaint();
            }
            catch (Exception e)
            {
                _status = "reconnect failed: " + e.Message;
                Debug.LogError("[Unterm] " + e);
            }
        }

        private void LoadNative()
        {
            try
            {
                // On Windows this maps the plugin into Unity's image and captures
                // its D3D device (for the zero-copy textures) before we bind below.
                UntermWindow.EnsureNativeImageLoaded();
                _native = new UntermNative();
                _native.Load(UntermWindow.PluginPath);

                var (pw, ph) = CurrentPanelSize();
                var (iw, ih) = CurrentInputSize();

                // Ensure the editor-global MCP server is up and its tools published
                // before the session starts (the session wires the agent to it).
                UntermMcp.EnsureStarted();

                // Re-adopt only when the live native view is genuinely THIS
                // window's conversation. On a domain reload the view (and its id)
                // survive, so it is. On an editor restart the native ids restart
                // from scratch, so a stale serialized id can point at another
                // window's fresh view — the session-id match rules that out, and we
                // recreate below instead.
                bool reAdopt = _viewId != 0 && _native.AgentviewExists(Vid)
                    && _native.AgentviewSessionId(Vid) == _claudeSessionId;
                if (!reAdopt)
                {
                    if (!string.IsNullOrEmpty(_claudeSessionId))
                    {
                        // Editor restart: restore THIS window's own conversation
                        // (its transcript is rebuilt from the session jsonl), or a
                        // fresh one if it can no longer be loaded.
                        _viewId = (long)_native.AgentviewLoad(ProjectRoot, _claudeSessionId, pw, ph, iw, ih, _effort, ClaudeCode.ClaudePath);
                        if (_viewId == 0)
                        {
                            _claudeSessionId = "";
                            _viewId = (long)_native.AgentviewCreate(ProjectRoot, pw, ph, iw, ih, _effort, ClaudeCode.ClaudePath);
                        }
                    }
                    else
                    {
                        // A freshly opened window (from the menu) always starts a
                        // NEW conversation; resuming a past one is an explicit
                        // choice via the header session picker.
                        _viewId = (long)_native.AgentviewCreate(ProjectRoot, pw, ph, iw, ih, _effort, ClaudeCode.ClaudePath);
                    }
                }


                ApplyFonts();
                ApplyAgentSettings();
                _refocus = true; // park the IME field for typing
                RenderView();
            }
            catch (Exception e)
            {
                _status = "load failed: " + e.Message;
                Debug.LogError("[Unterm] " + e);
                Teardown(keepView: false);
            }
        }

        // Prose renders in the OS's native proportional UI font, addressed by family
        // name (already loaded as a system font). Latin comes from this family;
        // Japanese (kana + kanji) falls back to the matching system face — Yu Gothic
        // on Windows, Hiragino on macOS — consistently, because the shared FontSystem
        // is built with a normalized locale (see gpu::font_system) so cosmic-text's
        // Han-unification fallback no longer mis-picks a Chinese font for kanji.
        // Bold/italic resolve from the family's own faces. Code blocks stay monospace
        // (renderer-hardcoded), so the panel reads like a chat, not a terminal.
        private void ApplyFonts()
        {
            if (_native == null || _viewId == 0) return;
#if UNITY_EDITOR_WIN
            const string ui = "Segoe UI";
#else
            const string ui = "Helvetica Neue";
#endif
            _native.AgentviewSetFonts(Vid, ui, "", "", "");
        }

        /// Tear down host-side resources. When <paramref name="keepView"/> is true
        /// (domain reload), leave the native view + loaded image alive so the
        /// conversation persists; otherwise destroy the view and unload.
        private void Teardown(bool keepView)
        {
            ClearRenderTextureCaches();
            if (_imeBgTex != null)
            {
                DestroyImmediate(_imeBgTex);
                _imeBgTex = null;
                _imeStyle = null;
            }

            // Drop the field before disposing so a re-entrant update tick bails on
            // the `_native == null` guard instead of calling through nulled delegates.
            var native = _native;
            _native = null;
            if (!keepView)
            {
                ulong vid = Vid;
                // Don't destroy the view if another live window still holds the same
                // id: maximizing a tab makes Unity spin up a transient duplicate
                // UntermAgentWindow sharing this view, and destroying that duplicate
                // (on un-maximize) would otherwise kill the conversation the original
                // window is still showing.
                bool ownedElsewhere = AnyOtherWindowOwns(vid);
                if (native != null && vid != 0 && !ownedElsewhere)
                    native.AgentviewDestroy(vid);
                _viewId = 0;
                native?.Dispose(); // dlclose on real teardown
            }
            // On reload: drop the managed wrapper WITHOUT dlclose so the native
            // image (and its view globals) stay mapped for re-adoption.
        }

        // True if a UntermAgentWindow other than this one holds view id `vid` — i.e.
        // a sibling (e.g. the duplicate created while a tab is maximized) still owns
        // the view, so this window's teardown must not destroy it.
        private bool AnyOtherWindowOwns(ulong vid)
        {
            if (vid == 0) return false;
            foreach (var w in Resources.FindObjectsOfTypeAll<UntermAgentWindow>())
                if (w != this && (ulong)w._viewId == vid) return true;
            return false;
        }

        private const float InputPad = 6f;
        private const float InputMaxHeight = 100f; // grow up to ~4 lines, then scroll
        // Logical width reserved on the right of the strip for the Rust-drawn
        // Send/Stop button (≈28px button + padding), so the opaque IME field is
        // never laid over it.
        private const float SendButtonReserve = 40f;

        // Y of the input strip's top edge: the composer docks at the window bottom;
        // while browsing it doubles as the search box and docks under the header.
        private float StripTop() => _browsing ? HeaderHeight : position.height - _inputHeight;

        // Y of the panel (transcript / session list) top edge.
        private float PanelTop() => _browsing ? HeaderHeight + _inputHeight : HeaderHeight;

        // Physical (HiDPI) pixel size of the transcript panel surface.
        private (uint, uint) CurrentPanelSize()
        {
            float ppp = EditorGUIUtility.pixelsPerPoint;
            uint w = (uint)Mathf.Max(1, Mathf.RoundToInt(position.width * ppp));
            uint h = (uint)Mathf.Max(
                1, Mathf.RoundToInt((position.height - HeaderHeight - _inputHeight) * ppp));
            return (w, h);
        }

        // Logical width of the input strip (the native surface spans field +
        // button area, i.e. the whole bottom strip minus side padding).
        private float InputStripWidth() => Mathf.Max(1f, position.width - InputPad * 2f);

        // Physical (HiDPI) pixel size of the input strip surface (includes the
        // Send/Stop button drawn by Rust on the right).
        private (uint, uint) CurrentInputSize()
        {
            float ppp = EditorGUIUtility.pixelsPerPoint;
            float fieldW = InputStripWidth();
            float fieldH = Mathf.Max(1f, _inputHeight - InputPad);
            uint w = (uint)Mathf.Max(1, Mathf.RoundToInt(fieldW * ppp));
            uint h = (uint)Mathf.Max(1, Mathf.RoundToInt(fieldH * ppp));
            return (w, h);
        }

        // Apply theme + scroll + size, re-render natively, then refresh both
        // external textures. `measureInput` re-fits the input strip to its content
        // (auto-grow); pass false for panel-only redraws (scroll, agent output) so
        // they don't disturb the input height.
        private void RenderView(bool measureInput = true)
        {
            if (_native == null || _viewId == 0) return;

            float ppp = EditorGUIUtility.pixelsPerPoint;
            var (pw, ph) = CurrentPanelSize();
            var (iw, ih) = CurrentInputSize();
            _native.AgentviewResize(Vid, pw, ph, iw, ih, ppp);

            Color bg = GetEditorBackground();
            Color32 fg = EditorGUIUtility.isProSkin
                ? new Color32(210, 210, 214, 255)
                : new Color32(32, 32, 32, 255);
            // Native clears in linear space; the sRGB target re-encodes on store.
            _native.AgentviewSetTheme(Vid, bg.linear, fg);

            _native.AgentviewSetScroll(Vid, _scroll);
            _native.AgentviewRender(Vid);

            UploadPanel((int)pw, (int)ph);
            UploadInput((int)iw, (int)ih);

            // Auto-grow the input strip to fit its content (capped). Only when the
            // input may have changed — never on a panel-only redraw, so scrolling
            // the transcript can't jiggle the input height.
            if (measureInput)
            {
                float contentLogical = _native.AgentviewInputHeight(Vid) / Mathf.Max(0.01f, ppp);
                float target = Mathf.Clamp(contentLogical + InputPad, InputHeight, InputMaxHeight);
                if (Mathf.Abs(target - _inputHeight) > 0.5f)
                {
                    _inputHeight = target;
                    Repaint();
                }
            }
        }

        private static System.Reflection.MethodInfo s_bgMethod;
        private static bool s_bgLooked;
        private static Color s_bgColor;
        private static bool s_bgDark, s_bgValid;

        private static Color GetEditorBackground()
        {
            bool dark = EditorGUIUtility.isProSkin;
            if (s_bgValid && s_bgDark == dark) return s_bgColor;
            if (!s_bgLooked)
            {
                s_bgLooked = true;
                var m = typeof(EditorGUIUtility).GetMethod(
                    "GetDefaultBackgroundColor",
                    System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
                if (m != null && m.ReturnType == typeof(Color)) s_bgMethod = m;
            }
            s_bgColor = s_bgMethod != null
                ? (Color)s_bgMethod.Invoke(null, null)
                : dark
                    ? (Color)new Color32(56, 56, 56, 255)
                    : (Color)new Color32(194, 194, 194, 255);
            s_bgDark = dark;
            s_bgValid = true;
            return s_bgColor;
        }

        // Wrap the native transcript texture directly — no CPU copy (zero-copy
        // only, like the terminal). The pointer alternates on Windows' double
        // buffer. Cache one Unity wrapper per pointer so the alternating buffers do
        // not allocate and destroy Texture2D objects every rendered frame.
        private void UploadPanel(int iw, int ih)
        {
            IntPtr texPtr = _native.AgentviewPanelTexture(Vid);
            if (texPtr == IntPtr.Zero) return;

            if (_panelTextureW != iw || _panelTextureH != ih)
            {
                ClearTextureCache(_panelTextures);
                _panelTextureW = iw;
                _panelTextureH = ih;
            }
            if (!_panelTextures.TryGetValue(texPtr, out var tex) || tex == null)
            {
                tex = Texture2D.CreateExternalTexture(
                    iw, ih, TextureFormat.RGBA32, false, false, texPtr);
                tex.filterMode = FilterMode.Bilinear;
                tex.hideFlags = HideFlags.HideAndDontSave;
                _panelTextures[texPtr] = tex;
            }
            _tex = tex;
        }

        // Wrap the native input strip texture (zero-copy only), caching both sides
        // of the Windows double buffer just like the transcript panel.
        private void UploadInput(int iw, int ih)
        {
            IntPtr texPtr = _native.AgentviewInputTexture(Vid);
            if (texPtr == IntPtr.Zero) return;

            if (_inputTextureW != iw || _inputTextureH != ih)
            {
                ClearTextureCache(_inputTextures);
                _inputTextureW = iw;
                _inputTextureH = ih;
            }
            if (!_inputTextures.TryGetValue(texPtr, out var tex) || tex == null)
            {
                tex = Texture2D.CreateExternalTexture(
                    iw, ih, TextureFormat.RGBA32, false, false, texPtr);
                tex.filterMode = FilterMode.Bilinear;
                tex.hideFlags = HideFlags.HideAndDontSave;
                _inputTextures[texPtr] = tex;
            }
            _inputTex = tex;
        }

        private void ClearRenderTextureCaches()
        {
            ClearTextureCache(_panelTextures);
            ClearTextureCache(_inputTextures);
            _tex = null;
            _inputTex = null;
            _panelTextureW = _panelTextureH = 0;
            _inputTextureW = _inputTextureH = 0;
        }

        private void ClearTextureCache(Dictionary<IntPtr, Texture2D> cache)
        {
            foreach (var texture in cache.Values)
            {
                if (texture != null) DestroyImmediate(texture);
            }
            cache.Clear();
        }

        private void OnGUI()
        {
            // Snapshot IME composition at Layout so key handling is stable; a
            // non-empty -> empty transition flags the frame that committed a phrase.
            if (Event.current.type == EventType.Layout)
            {
                bool now = !string.IsNullOrEmpty(Input.compositionString);
                _composeJustEnded = _prevComposing && !now;
                _prevComposing = now;
                _composing = now;
            }
            // Preedit/commit is synced in SyncIme (after DrawImeField), so it can
            // include any segments the IME has already committed into the field.

            DrawHeader();

            // While browsing, Esc leaves the browser (checked before the composer
            // key routing, which would otherwise treat Esc as an interrupt).
            if (_browsing && Event.current.type == EventType.KeyDown
                && Event.current.keyCode == KeyCode.Escape)
            {
                ExitBrowse();
                Event.current.Use();
                return;
            }

            // Keystrokes go to the native input box; do this before the panel/IMGUI
            // controls so Enter/arrows aren't eaten by them. (While browsing the
            // composer is the browser's search box; Enter opens the top match —
            // resolved natively.)
            HandleInputKeys();

            // Follow window resizing / input auto-grow: re-render whenever the draw
            // area no longer matches the current textures.
            var (cw, ch) = CurrentPanelSize();
            var (ciw, cih) = CurrentInputSize();
            if (_native != null && _viewId != 0 &&
                (_tex == null || _tex.width != (int)cw || _tex.height != (int)ch ||
                 _inputTex == null || _inputTex.width != (int)ciw || _inputTex.height != (int)cih))
            {
                RenderView();
            }

            // The transcript area; while browsing the input strip moves to the top
            // (search box), so the panel sits below it instead of above.
            var rect = new Rect(0, PanelTop(), position.width,
                position.height - HeaderHeight - _inputHeight);

            // Hover drives the native browser's row highlight / archive icon.
            if (_browsing && _native != null && _viewId != 0
                && (Event.current.type == EventType.MouseMove || Event.current.type == EventType.MouseDrag))
            {
                float bpp = EditorGUIUtility.pixelsPerPoint;
                var mp = Event.current.mousePosition;
                float bx = (mp.x - rect.x) * bpp;
                float by = (mp.y - rect.y) * bpp;
                if (_native.AgentviewBrowseHover(Vid, bx, by))
                {
                    RenderView(measureInput: false);
                    Repaint();
                }
            }

            // While the `/`-completion popup is open, the wheel scrolls the popup list
            // (host-driven: feed the offset and re-push) instead of the transcript.
            if (Event.current.type == EventType.ScrollWheel && _slashOpen && _slashItems.Count > 0)
            {
                var we = Event.current;
                if (Mathf.Abs(we.delta.y) > 0.01f)
                {
                    int vis = Mathf.Min(_slashItems.Count, SlashRows);
                    int max = Mathf.Max(0, _slashItems.Count - vis);
                    _slashScroll = Mathf.Clamp(_slashScroll + (we.delta.y > 0 ? 1 : -1), 0, max);
                    PushSlash();
                    we.Use();
                }
                return;
            }

            // Mouse-wheel scroll through history (offset is in physical px).
            // Horizontal wheel/swipe over a code block scrolls that block instead.
            if (Event.current.type == EventType.ScrollWheel && rect.Contains(Event.current.mousePosition))
            {
                var we = Event.current;
                float ppp = EditorGUIUtility.pixelsPerPoint;
                float step = 24f * ppp;
                bool used = false;
                if (Mathf.Abs(we.delta.x) > 0.01f && _native != null && _viewId != 0)
                {
                    float lx = (we.mousePosition.x - rect.x) * ppp;
                    float ly = (we.mousePosition.y - rect.y) * ppp;
                    used = _native.AgentviewPanelScrollH(Vid, lx, ly, we.delta.x * step) == 1;
                }
                if (Mathf.Abs(we.delta.y) > 0.01f)
                {
                    // A capped plan box under the pointer scrolls internally first;
                    // otherwise the wheel scrolls the whole transcript.
                    float lx = (we.mousePosition.x - rect.x) * ppp;
                    float ly = (we.mousePosition.y - rect.y) * ppp;
                    if (_native != null && _viewId != 0
                        && _native.AgentviewPanelScrollV(Vid, lx, ly, we.delta.y * step) == 1)
                    {
                        used = true;
                    }
                    else
                    {
                        // Transcript scroll is bottom-anchored (0 = latest); the
                        // browser list is top-anchored (0 = top), so the wheel's
                        // sign flips between them.
                        float d = we.delta.y * step;
                        _scroll = Mathf.Clamp(_browsing ? _scroll + d : _scroll - d, 0f, MaxScroll());
                        used = true;
                    }
                }
                if (used)
                {
                    RenderView(measureInput: false);
                    Repaint();
                    we.Use();
                }
            }

            HandlePanelMouse(rect);

            if (_tex != null)
            {
                // Native frame is top-down; Texture2D samples bottom-up, so flip V.
                GUI.DrawTextureWithTexCoords(rect, _tex, new Rect(0, 1, 1, -1));
                DrawScrollbar(rect);
                DrawStampTooltip(rect);
            }
            else
            {
                EditorGUI.LabelField(rect, _status, EditorStyles.centeredGreyMiniLabel);
            }

            DrawInput();

            // The hidden IME field overlays the caret; flush committed text into
            // the native input box, then keep it focused for the next keystroke.
            DrawImeField(InputStripRect());
            SyncIme();
            // Refresh the `/`-command popup from the composer's current caret context
            // (after DrawImeField cached the anchor and SyncIme flushed typed text).
            UpdateSlashCompletion();
            if (_refocus && Event.current.type == EventType.Repaint)
            {
                EditorGUI.FocusTextInControl(InputControl);
                _refocus = false;
            }
        }

        // Transcript mouse: down resolves permission buttons AND begins selection
        // internally (Rust); drag extends the selection; right-click opens a menu.
        private void HandlePanelMouse(Rect rect)
        {
            if (_native == null || _viewId == 0) return;
            var e = Event.current;
            if (!rect.Contains(e.mousePosition) && e.type != EventType.MouseDrag && e.type != EventType.MouseUp)
            {
                if (_hoverStamp != 0) { _hoverStamp = 0; Repaint(); }
                return;
            }

            // The scrollbar strip belongs to DrawScrollbar's GUI.VerticalScrollbar;
            // don't swallow a click there or the bar can never be grabbed.
            if (e.type == EventType.MouseDown && MaxScroll() > 0.5f
                && e.mousePosition.x >= rect.xMax - ScrollbarWidth)
                return;

            float ppp = EditorGUIUtility.pixelsPerPoint;
            float lx = (e.mousePosition.x - rect.x) * ppp;
            float ly = (e.mousePosition.y - rect.y) * ppp;

            switch (e.type)
            {
                case EventType.MouseDown when e.button == 0:
                    _native.AgentviewPanelDown(Vid, lx, ly);
                    _selecting = true;
                    RenderView(measureInput: false); Repaint(); e.Use();
                    break;

                case EventType.MouseDrag when _selecting:
                    _native.AgentviewPanelDrag(Vid, lx, ly);
                    RenderView(measureInput: false); Repaint(); e.Use();
                    break;

                case EventType.MouseUp when _selecting:
                    _selecting = false;
                    // A plain click (no drag-selection) on a file path opens it: the
                    // configured script editor first, then Unity's asset pipeline or
                    // the OS default app on decline. OpenFromAgent no-ops for tokens
                    // that aren't existing files (matching the underline).
                    if (!_native.AgentviewPanelHasSelection(Vid))
                    {
                        string tok = _native.AgentviewPanelTokenAt(Vid, lx, ly);
                        if (!string.IsNullOrEmpty(tok))
                            UntermCodeEditorWindow.OpenFromAgent(tok, ProjectRoot);
                    }
                    e.Use();
                    break;

                case EventType.ContextClick:
                    ShowContextMenu();
                    e.Use();
                    break;

                case EventType.MouseMove:
                {
                    // Hovering a relative time separator reveals the exact time.
                    ulong stamp = _native.AgentviewPanelStampAt(Vid, lx, ly);
                    if (stamp != _hoverStamp) { _hoverStamp = stamp; Repaint(); }
                    break;
                }
            }
        }

        // The separator labels are relative ("5 minutes ago"); hovering one shows
        // the absolute local time in a small box by the cursor.
        private void DrawStampTooltip(Rect rect)
        {
            if (_hoverStamp == 0 || Event.current.type != EventType.Repaint) return;
            var mp = Event.current.mousePosition;
            if (!rect.Contains(mp)) return;
            var local = DateTimeOffset.FromUnixTimeSeconds((long)_hoverStamp).ToLocalTime();
            var content = new GUIContent(local.ToString("yyyy-MM-dd HH:mm"));
            var label = EditorStyles.miniLabel;
            var size = label.CalcSize(content);
            const float padX = 6f, padY = 3f;
            var r = new Rect(mp.x - size.x - padX * 2 - 8f, mp.y + 14f, size.x + padX * 2, size.y + padY * 2);
            if (r.x < rect.x) r.x = mp.x + 12f;                 // flip right if clipped
            if (r.yMax > rect.yMax) r.y = mp.y - r.height - 6f; // flip above if clipped
            // EditorStyles.helpBox is translucent and lets the panel texture bleed
            // through, so paint an opaque fill + 1px border ourselves, then the text.
            bool pro = EditorGUIUtility.isProSkin;
            EditorGUI.DrawRect(r, pro ? new Color(0.16f, 0.16f, 0.16f) : new Color(0.94f, 0.94f, 0.94f));
            var border = pro ? new Color(0f, 0f, 0f, 0.6f) : new Color(0f, 0f, 0f, 0.25f);
            EditorGUI.DrawRect(new Rect(r.x, r.y, r.width, 1f), border);
            EditorGUI.DrawRect(new Rect(r.x, r.yMax - 1f, r.width, 1f), border);
            EditorGUI.DrawRect(new Rect(r.x, r.y, 1f, r.height), border);
            EditorGUI.DrawRect(new Rect(r.xMax - 1f, r.y, 1f, r.height), border);
            var textRect = new Rect(r.x + padX, r.y + padY, size.x, size.y);
            var prev = label.normal.textColor;
            label.normal.textColor = pro ? new Color(0.85f, 0.85f, 0.85f) : new Color(0.1f, 0.1f, 0.1f);
            GUI.Label(textRect, content, label);
            label.normal.textColor = prev; // shared editor style: restore
        }

        private void ShowContextMenu()
        {
            var menu = new GenericMenu();
            if (_native != null && _viewId != 0 && _native.AgentviewPanelHasSelection(Vid))
                menu.AddItem(new GUIContent("Copy"), false,
                    () => CopyToClipboard(_native.AgentviewPanelSelectedText(Vid)));
            else
                menu.AddDisabledItem(new GUIContent("Copy"));
            menu.AddItem(new GUIContent("Select All"), false, () =>
            {
                _native.AgentviewPanelSelectAll(Vid); RenderView(measureInput: false); Repaint();
            });
            menu.ShowAsContext();
        }

        private static void CopyToClipboard(string text)
        {
            if (!string.IsNullOrEmpty(text)) EditorGUIUtility.systemCopyBuffer = text;
        }

        // Max scroll offset (physical px): content beyond the viewport.
        private float MaxScroll()
        {
            if (_native == null || _viewId == 0) return 0f;
            float ppp = EditorGUIUtility.pixelsPerPoint;
            float viewportH = (position.height - HeaderHeight - _inputHeight) * ppp;
            return Mathf.Max(0f, _native.AgentviewContentHeight(Vid) - viewportH);
        }

        // Draggable scrollbar on the right edge (physical px; 0 = top, max = latest).
        private void DrawScrollbar(Rect panelRect)
        {
            if (_native == null || _viewId == 0) return;

            float ppp = EditorGUIUtility.pixelsPerPoint;
            float viewportH = panelRect.height * ppp; // physical
            float totalH = _native.AgentviewContentHeight(Vid);
            float maxScroll = Mathf.Max(0f, totalH - viewportH);
            if (maxScroll <= 0.5f)
            {
                _scroll = 0f;
                return;
            }

            _scroll = Mathf.Clamp(_scroll, 0f, maxScroll);
            var sbRect = new Rect(panelRect.xMax - ScrollbarWidth, panelRect.y, ScrollbarWidth, panelRect.height);
            // The transcript is bottom-anchored (scroll 0 = latest); the browser
            // list is top-anchored (scroll 0 = top).
            float value = _browsing ? _scroll : maxScroll - _scroll;

            EditorGUI.BeginChangeCheck();
            float nv = GUI.VerticalScrollbar(sbRect, value, viewportH, 0f, totalH);
            if (EditorGUI.EndChangeCheck())
            {
                _scroll = Mathf.Clamp(_browsing ? nv : maxScroll - nv, 0f, maxScroll);
                RenderView(measureInput: false);
                Repaint();
            }
        }

        // Forward keystrokes to the native input box. Enter sends, Shift+Enter
        // newlines (both resolved in Rust); Esc interrupts a running turn; clipboard
        // shortcuts route through the native box.
        private void HandleInputKeys()
        {
            if (_native == null || _viewId == 0) return;
            var e = Event.current;
            if (e.type != EventType.KeyDown) return;

            // While composing, let every key reach the IME field (Enter commits,
            // arrows move the candidate, Backspace edits the composition).
            if (_composing) return;

            // The Enter that commits a composition arrives the frame after
            // compositionString cleared; swallow it so it doesn't also send.
            if (_composeJustEnded &&
                (e.keyCode == KeyCode.Return || e.keyCode == KeyCode.KeypadEnter))
            {
                e.Use();
                return;
            }

            // Shift+Tab cycles the permission mode (Claude Code convention).
            if (e.keyCode == KeyCode.Tab && e.shift)
            {
                CyclePermissionMode();
                e.Use();
                return;
            }

            // Cmd/Ctrl+C with a transcript selection copies that (transcript takes
            // precedence over the input box); leave the selection untouched.
            if ((e.command || e.control) && e.keyCode == KeyCode.C
                && _native.AgentviewPanelHasSelection(Vid))
            {
                CopyToClipboard(_native.AgentviewPanelSelectedText(Vid));
                e.Use();
                return;
            }

            // Any other key targets the input box, so it takes selection focus:
            // drop the transcript selection so only one highlight is active.
            FocusInput();

            // Slash-command completion popup open: navigate / accept / dismiss before
            // the keys reach the composer (Enter would otherwise send, arrows move the
            // caret, Escape would interrupt the agent).
            if (_slashOpen && _slashItems.Count > 0)
            {
                switch (e.keyCode)
                {
                    case KeyCode.DownArrow:
                        _slashSel = (_slashSel + 1) % _slashItems.Count; EnsureSlashVisible(); PushSlash(); e.Use(); return;
                    case KeyCode.UpArrow:
                        _slashSel = (_slashSel - 1 + _slashItems.Count) % _slashItems.Count; EnsureSlashVisible(); PushSlash(); e.Use(); return;
                    case KeyCode.Tab:
                    case KeyCode.Return:
                    case KeyCode.KeypadEnter:
                        AcceptSlash(); e.Use(); return;
                    case KeyCode.Escape:
                        CloseSlash(); e.Use(); return;
                    case KeyCode.LeftArrow:
                    case KeyCode.RightArrow:
                    case KeyCode.Home:
                    case KeyCode.End:
                        CloseSlash(); break; // fall through to normal caret motion
                }
            }

            if (e.keyCode == KeyCode.Escape)
            {
                _native.AgentviewInterrupt(Vid);
                e.Use();
                return;
            }

            // Clipboard shortcuts (Cmd/Ctrl + V/C/X/A/Z).
            if (e.command || e.control)
            {
                switch (e.keyCode)
                {
                    case KeyCode.V:
                        _native.AgentviewInputInsert(Vid, EditorGUIUtility.systemCopyBuffer);
                        RenderView(); Repaint(); e.Use();
                        return;
                    case KeyCode.C:
                    {
                        string s = _native.AgentviewInputCopy(Vid);
                        if (!string.IsNullOrEmpty(s)) EditorGUIUtility.systemCopyBuffer = s;
                        e.Use();
                        return;
                    }
                    case KeyCode.X:
                    {
                        string s = _native.AgentviewInputCut(Vid);
                        if (!string.IsNullOrEmpty(s)) EditorGUIUtility.systemCopyBuffer = s;
                        RenderView(); Repaint(); e.Use();
                        return;
                    }
                    case KeyCode.A:
                        _native.AgentviewInputSelectAll(Vid);
                        RenderView(); Repaint(); e.Use();
                        return;
                    case KeyCode.Z when !e.shift:
                        _native.AgentviewInputUndo(Vid);
                        RenderView(); Repaint(); e.Use();
                        return;
                    case KeyCode.Z when e.shift:
                        _native.AgentviewInputRedo(Vid);
                        RenderView(); Repaint(); e.Use();
                        return;
                }
            }

            // Caret motion: arrows / Home / End, plus modifier combos (word, line
            // start/end, document start/end, page) — same shortcuts as the code
            // editor. Resolved per-platform, then forwarded as a semantic name.
            string motion = ResolveMotion(e);
            if (motion != null)
            {
                _native.AgentviewInputKey(Vid, motion, e.control, e.alt, e.shift);
                RenderView(); Repaint(); e.Use();
                return;
            }

            // Word / line deletion. macOS: Option+Backspace = delete word, Cmd+
            // Backspace = delete to line start, Option+Delete = delete word forward.
            // Windows/Linux: Ctrl+Backspace/Delete = delete word.
            if (e.keyCode == KeyCode.Backspace && (e.alt || e.command || e.control))
            {
#if UNITY_EDITOR_OSX
                string n = e.command ? "DeleteToLineStart" : "DeleteWordBack";
#else
                string n = "DeleteWordBack";
#endif
                _native.AgentviewInputKey(Vid, n, e.control, e.alt, e.shift);
                RenderView(); Repaint(); e.Use();
                return;
            }
            if (e.keyCode == KeyCode.Delete && (e.alt || e.control))
            {
                _native.AgentviewInputKey(Vid, "DeleteWordForward", e.control, e.alt, e.shift);
                RenderView(); Repaint(); e.Use();
                return;
            }

            // Enter/editing keys: hand them to Rust (Enter=send, Shift+Enter=newline,
            // the rest are caret/edit operations). Plain printable input is left to
            // the hidden IME field.
            string name = e.keyCode switch
            {
                KeyCode.Return => "Return",
                KeyCode.KeypadEnter => "Return",
                KeyCode.Backspace => "Backspace",
                KeyCode.Delete => "Delete",
                _ => null,
            };
            if (name != null)
            {
                _native.AgentviewInputKey(Vid, name, e.control, e.alt, e.shift);
                if (name == "Return" && !e.shift) _scroll = 0f; // jump to latest on send
                RenderView();
                Repaint();
                e.Use();
                return;
            }
        }

        // Map an arrow/Home/End keystroke (with modifiers) to a semantic motion name
        // the composer understands — the same shortcuts as the code editor. Returns
        // null for non-motion keys. macOS: Cmd+←/→ = line start/end, Cmd+↑/↓ =
        // document start/end, Option+←/→ = word. Windows/Linux: Ctrl+←/→ = word,
        // Ctrl+Home/End = document.
        private static string ResolveMotion(Event e)
        {
#if UNITY_EDITOR_OSX
            bool word = e.alt;
            bool ends = e.command;
            switch (e.keyCode)
            {
                case KeyCode.LeftArrow:  return word ? "WordLeft"  : ends ? "LineStart" : "LeftArrow";
                case KeyCode.RightArrow: return word ? "WordRight" : ends ? "LineEnd"   : "RightArrow";
                case KeyCode.UpArrow:    return ends ? "DocStart" : "UpArrow";
                case KeyCode.DownArrow:  return ends ? "DocEnd"   : "DownArrow";
                case KeyCode.Home:       return "LineStart";
                case KeyCode.End:        return "LineEnd";
                case KeyCode.PageUp:     return "PageUp";
                case KeyCode.PageDown:   return "PageDown";
                default: return null;
            }
#else
            bool word = e.control;
            switch (e.keyCode)
            {
                case KeyCode.LeftArrow:  return word ? "WordLeft"  : "LeftArrow";
                case KeyCode.RightArrow: return word ? "WordRight" : "RightArrow";
                case KeyCode.UpArrow:    return "UpArrow";
                case KeyCode.DownArrow:  return "DownArrow";
                case KeyCode.Home:       return e.control ? "DocStart" : "LineStart";
                case KeyCode.End:        return e.control ? "DocEnd"   : "LineEnd";
                case KeyCode.PageUp:     return "PageUp";
                case KeyCode.PageDown:   return "PageDown";
                default: return null;
            }
#endif
        }

        // Mouse on the input strip: click places the caret (or hits the Send/Stop
        // button, resolved in Rust), drag selects, double/triple click selects
        // word/line, wheel scrolls, right-click opens a menu.
        private void HandleInputMouse(Rect stripRect)
        {
            if (_native == null || _viewId == 0) return;
            var e = Event.current;
            float ppp = EditorGUIUtility.pixelsPerPoint;
            float lx = (e.mousePosition.x - stripRect.x) * ppp;
            float ly = (e.mousePosition.y - stripRect.y) * ppp;

            switch (e.type)
            {
                case EventType.MouseDown when e.button == 0 && stripRect.Contains(e.mousePosition):
                    byte kind = e.clickCount >= 3 ? (byte)3 : e.clickCount == 2 ? (byte)2 : (byte)0;
                    byte hit = _native.AgentviewInputDown(Vid, lx, ly, kind);
                    if (hit == 1)
                    {
                        // The Send/Stop action already ran in Rust; do not drag.
                        _scroll = 0f; // a send jumps to latest
                        RenderView(); Repaint(); e.Use();
                        break;
                    }
                    _inputDragging = true;
                    GUIUtility.keyboardControl = 0;
                    Focus();
                    _refocus = true; // re-park the IME field for typing
                    FocusInput();    // clicking the input drops the transcript selection
                    RenderView(); Repaint(); e.Use();
                    break;
                case EventType.MouseDrag when _inputDragging:
                    _native.AgentviewInputDrag(Vid, lx, ly);
                    RenderView(); Repaint(); e.Use();
                    break;
                case EventType.MouseUp when _inputDragging:
                    _inputDragging = false; e.Use();
                    break;
                // The composer doesn't free-scroll: it's capped (~4 lines) and the
                // editor auto-follows the caret while typing. A wheel over it does
                // nothing (the transcript is the scrollable area).
                case EventType.ContextClick when stripRect.Contains(e.mousePosition):
                    ShowInputContextMenu();
                    e.Use();
                    break;
            }
        }

        private void ShowInputContextMenu()
        {
            var menu = new GenericMenu();
            // Probe selection via copy (returns "" when there's no selection).
            bool hasSel = !string.IsNullOrEmpty(_native.AgentviewInputCopy(Vid));
            if (hasSel)
            {
                menu.AddItem(new GUIContent("Copy"), false, () =>
                {
                    string s = _native.AgentviewInputCopy(Vid);
                    if (!string.IsNullOrEmpty(s)) EditorGUIUtility.systemCopyBuffer = s;
                });
                menu.AddItem(new GUIContent("Cut"), false, () =>
                {
                    string s = _native.AgentviewInputCut(Vid);
                    if (!string.IsNullOrEmpty(s)) EditorGUIUtility.systemCopyBuffer = s;
                    RenderView(); Repaint();
                });
            }
            else
            {
                menu.AddDisabledItem(new GUIContent("Copy"));
                menu.AddDisabledItem(new GUIContent("Cut"));
            }
            menu.AddItem(new GUIContent("Paste"), false, () =>
            {
                _native.AgentviewInputInsert(Vid, EditorGUIUtility.systemCopyBuffer);
                RenderView(); Repaint();
            });
            menu.AddItem(new GUIContent("Select All"), false, () =>
            {
                _native.AgentviewInputSelectAll(Vid);
                RenderView(); Repaint();
            });
            menu.ShowAsContext();
        }

        // Selection focus moves to the input: drop any transcript selection so a
        // single highlight (and a single Cmd+C target) is active at a time.
        private void FocusInput()
        {
            if (_native != null && _viewId != 0 && _native.AgentviewPanelHasSelection(Vid))
            {
                _native.AgentviewPanelSelectClear(Vid);
                RenderView();
            }
        }

        // The input strip rect (where the native input texture is blitted), shared
        // by DrawInput, the mouse handler, and the IME field. Spans the whole
        // bottom strip width (field + Send/Stop button) minus side padding.
        private Rect InputStripRect()
        {
            var strip = new Rect(0, StripTop(), position.width, _inputHeight);
            return new Rect(strip.x + InputPad, strip.y + InputPad / 2f,
                InputStripWidth(), strip.height - InputPad);
        }

        private void DrawInput()
        {
            var strip = new Rect(0, StripTop(), position.width, _inputHeight);
            // Divider on the transcript-facing edge: above the composer, below the
            // browser's search box.
            float divY = _browsing ? strip.yMax - 1f : strip.y;
            EditorGUI.DrawRect(new Rect(strip.x, divY, strip.width, 1f),
                EditorGUIUtility.isProSkin ? new Color(0, 0, 0, 0.4f) : new Color(0, 0, 0, 0.15f));

            var stripRect = InputStripRect();
            if (_inputTex != null)
                GUI.DrawTextureWithTexCoords(stripRect, _inputTex, new Rect(0, 1, 1, -1));

            // The Send/Stop button is drawn inside the input texture by Rust; the
            // host only forwards the click via AgentviewInputDown.
            HandleInputMouse(stripRect);
        }

        // The hidden IMGUI field that drives IME + plain typing. The composition
        // itself is shown inline by the editor (as preedit/marked text), so this
        // field is always invisible and — while composing — parked offscreen so
        // the OS doesn't also draw the composition. It still receives the OS
        // composition + committed text; SyncIme reads both and commits the latter.
        private void DrawImeField(Rect stripRect)
        {
            if (_native == null || _viewId == 0) return;
            // No keyboard focus → skip the hidden IME field entirely. It only exists
            // to anchor composition and receive typing (both need focus), and its
            // transparent-text TextField still draws a thin text cursor at the caret —
            // which must not linger on a background (unfocused) window.
            if (focusedWindow != this && !_composing && string.IsNullOrEmpty(Input.compositionString))
                return;
            float ppp = EditorGUIUtility.pixelsPerPoint;
            _native.AgentviewCaret(Vid, out float cx, out float cy, out float _, out float chh);
            float gx = stripRect.x + cx / ppp;
            float gy = stripRect.y + cy / ppp;
            float gh = Mathf.Max(14f, chh / ppp);

            // Cache the caret TOP in screen points for the native `/`-completion popup,
            // which anchors ABOVE the composer (it's docked at the window bottom).
            if (Event.current.type == EventType.Repaint)
            {
                var spTop = GUIUtility.GUIToScreenPoint(new Vector2(gx, gy));
                _popupAnchorX = spTop.x;
                _popupAnchorTopY = spTop.y;
                _popupScale = ppp;
            }

            // Unity caches the field's TextEditor by control id and doesn't re-clamp
            // its caret when `_imeBuffer` is reset out from under it (after a commit /
            // send), so a stale index throws ArgumentOutOfRange inside ReplaceSelection
            // on the next keystroke. Clamp the focused editor to the current buffer.
            if (GUIUtility.keyboardControl != 0
                && GUIUtility.GetStateObject(typeof(TextEditor), GUIUtility.keyboardControl) is TextEditor kte)
            {
                kte.cursorIndex = Mathf.Min(kte.cursorIndex, _imeBuffer.Length);
                kte.selectIndex = Mathf.Min(kte.selectIndex, _imeBuffer.Length);
            }

            GUI.SetNextControlName(InputControl);
            // The editor IME anchors the candidate window to this field's caret (not
            // to compositionCursorPos), so the field must sit AT the caret, never
            // parked off-screen. Its text is fully transparent (ImeHidden) so the OS
            // inline composition stays hidden behind the natively drawn preedit.
            bool composing = _composing || !string.IsNullOrEmpty(Input.compositionString);
            var style = ImeHidden();
            if (composing)
            {
                // Right-align so the (invisible) marked text ENDS at the caret,
                // pinning the candidate anchor at the composition start regardless of
                // text length or font — otherwise it drifts right as you type. A tiny
                // field misplaces the anchor, so it must span toward the window edge.
                style.alignment = TextAnchor.UpperRight;
                float w = Mathf.Max(120f, gx);
                _imeBuffer = GUI.TextField(new Rect(gx - w, gy, w, gh), _imeBuffer, style);
            }
            else
            {
                // Idle it's 2px so it doesn't intercept composer clicks.
                style.alignment = TextAnchor.UpperLeft;
                _imeBuffer = GUI.TextField(new Rect(gx, gy, 2f, gh), _imeBuffer, style);
            }
            // compositionCursorPos is in the focused window's LOCAL GUI space, not
            // screen space — GUIToScreenPoint added the window's desktop offset, so the
            // candidate was only correct with the window at the screen's top-left. Pass
            // the window-local point, a line below the caret so it clears the preedit.
            // Only the focused window may move it (the position is process-global).
            if (focusedWindow == this)
                Input.compositionCursorPos = new Vector2(gx, gy + gh * 1.5f);
        }

        // A style whose text is fully transparent in every state, so the IME field
        // (and the inline marked text Unity draws into it) is invisible while the
        // field still occupies the caret position the candidate window anchors to.
        private GUIStyle ImeHidden()
        {
            if (_imeHidden == null)
            {
                _imeHidden = new GUIStyle(GUIStyle.none);
                var clear = new Color(0f, 0f, 0f, 0f);
                _imeHidden.normal.textColor = clear;
                _imeHidden.focused.textColor = clear;
                _imeHidden.hover.textColor = clear;
                _imeHidden.active.textColor = clear;
            }
            return _imeHidden;
        }

        // Sync IME state into the native input box each frame.
        //
        // While composing, show the segments the IME has already committed into the
        // field PLUS the active composition together as inline preedit (marked
        // text). The field text (`_imeBuffer`) holds segments confirmed mid-phrase
        // (e.g. after a 漢字 conversion) while `Input.compositionString` holds the
        // segment still being edited; showing only the latter made a converted
        // segment appear to vanish as you kept typing. Nothing is inserted for real
        // until the phrase commits, and the field is never mutated mid-composition
        // (which would disturb the OS IME).
        //
        // Once composition ends (or for plain typing), drop the marked text and
        // commit the field for real, once, without dropping focus.
        private void SyncIme()
        {
            if (_native == null || _viewId == 0) return;

            // IME state (Input.compositionString) is process-global, so an
            // unfocused window must NOT mirror it — otherwise the 変換中 preedit
            // appears in every open agent window. Clear any preedit this window
            // left and bail; only the focused window drives composition.
            if (focusedWindow != this)
            {
                if (!string.IsNullOrEmpty(_lastPreedit))
                {
                    _native.AgentviewInputSetPreedit(Vid, "");
                    _lastPreedit = "";
                    RenderView();
                    Repaint();
                }
                return;
            }

            if (_composing)
            {
                string marked = _imeBuffer + Input.compositionString;
                if (marked != _lastPreedit)
                {
                    _lastPreedit = marked;
                    _native.AgentviewInputSetPreedit(Vid, marked);
                    RenderView();
                    Repaint();
                }
                return;
            }

            if (Event.current.type != EventType.Repaint) return;

            if (!string.IsNullOrEmpty(_lastPreedit))
            {
                _native.AgentviewInputSetPreedit(Vid, "");
                _lastPreedit = "";
            }
            if (string.IsNullOrEmpty(_imeBuffer)) return;

            _native.AgentviewInputInsert(Vid, _imeBuffer);
            _imeBuffer = "";
            var te = (TextEditor)GUIUtility.GetStateObject(typeof(TextEditor), GUIUtility.keyboardControl);
            if (te != null) { te.text = ""; te.cursorIndex = 0; te.selectIndex = 0; }
            FocusInput(); // typing drops the transcript selection
            RenderView();
            Repaint();
        }

        // Opaque, themed style so the inline composition is legible over the box.
        private GUIStyle ImeStyle()
        {
            Color bg = GetEditorBackground();
            Color32 fg = EditorGUIUtility.isProSkin
                ? new Color32(210, 210, 214, 255)
                : new Color32(32, 32, 32, 255);
            if (_imeBgTex == null)
                _imeBgTex = new Texture2D(1, 1) { hideFlags = HideFlags.HideAndDontSave };
            _imeBgTex.SetPixel(0, 0, bg);
            _imeBgTex.Apply();
            if (_imeStyle == null)
            {
                _imeStyle = new GUIStyle(EditorStyles.label)
                {
                    richText = false,
                    padding = new RectOffset(1, 1, 0, 0),
                    alignment = TextAnchor.MiddleLeft,
                };
            }
            _imeStyle.normal.background = _imeBgTex;
            _imeStyle.normal.textColor = fg;
            _imeStyle.focused.background = _imeBgTex;
            _imeStyle.focused.textColor = fg;
            return _imeStyle;
        }

        // A thin header with the session picker: the current conversation's title
        // and a dropdown to start a new one or switch to another past conversation.
        private void DrawHeader()
        {
            // Browser chrome: Back on the left, the archived-visibility toggle on
            // the right (only offered once something is archived). The list itself
            // is native; these are the only IMGUI pieces of the browser.
            if (_browsing)
            {
                using (new GUILayout.HorizontalScope(EditorStyles.toolbar))
                {
                    if (GUILayout.Button("‹ Back", EditorStyles.toolbarButton, GUILayout.Width(58)))
                    {
                        ExitBrowse();
                        return;
                    }
                    GUILayout.FlexibleSpace();
                    if (_native != null && _viewId != 0 && _native.AgentviewBrowseArchivedCount(Vid) > 0
                        && GUILayout.Button("Archived", EditorStyles.toolbarButton, GUILayout.Width(66)))
                    {
                        _native.AgentviewBrowseToggleArchived(Vid);
                        RenderView(measureInput: false);
                        Repaint();
                    }
                }
                return;
            }
            using (new GUILayout.HorizontalScope(EditorStyles.toolbar))
            {
                // Session picker (shrinks so the settings dropdowns always fit).
                string label = CurrentTitle();
                if (EditorGUILayout.DropdownButton(new GUIContent(label), FocusType.Passive,
                    EditorStyles.toolbarDropDown, GUILayout.MaxWidth(Mathf.Max(40f, position.width - 250f))))
                {
                    ShowSessionMenu(GUILayoutUtility.GetLastRect());
                }
                GUILayout.FlexibleSpace();

                // Follow-up queue indicator (only while prompts are waiting).
                uint q = (_native != null && _viewId != 0) ? _native.AgentviewQueueLen(Vid) : 0u;
                if (q > 0)
                    GUILayout.Label(new GUIContent("⏳" + q, "Queued follow-up prompts"),
                        EditorStyles.toolbarButton, GUILayout.MaxWidth(38f));

                // Separate dropdowns on the right: permission mode / model / effort.
                // Each menu is anchored at the cursor (ShowAsContext) so it drops
                // under its button.
                if (EditorGUILayout.DropdownButton(new GUIContent(ModeLabel(), "Permission mode (Shift+Tab to cycle)"),
                    FocusType.Passive, EditorStyles.toolbarDropDown, GUILayout.MaxWidth(72f)))
                    ShowModeMenu();
                if (EditorGUILayout.DropdownButton(new GUIContent(ModelLabel(), "Model"),
                    FocusType.Passive, EditorStyles.toolbarDropDown, GUILayout.MaxWidth(72f)))
                    ShowModelMenu();
                if (EditorGUILayout.DropdownButton(new GUIContent(EffortLabel(), "Reasoning effort (respawns to change)"),
                    FocusType.Passive, EditorStyles.toolbarDropDown, GUILayout.MaxWidth(70f)))
                    ShowEffortMenu();
            }
        }

        private string CurrentTitle()
        {
            string t = (_native != null && _viewId != 0) ? _native.AgentviewTitle(Vid) : "";
            return string.IsNullOrEmpty(t) ? "New conversation" : t;
        }

        // Unity's native popup menu (GenericMenu), so it looks and behaves like one.
        // Its one quirk is that it keys items by label, so same-titled conversations
        // would collapse — disambiguate repeats with trailing spaces (see below). A
        // session already driven by another window is added disabled (greyed,
        // non-selectable). ('/' is a submenu separator here, so neutralize it.)
        private void ShowSessionMenu(Rect activator)
        {
            var menu = new GenericMenu();
            menu.AddItem(new GUIContent("New Session"), false, NewSession);
            if (_recent.Length > 0) menu.AddSeparator("");

            var used = new HashSet<string>();
            foreach (var s in _recent)
            {
                string title = string.IsNullOrEmpty(s.title) ? "(untitled)" : s.title;
                if (s.updated > 0 && _native != null)
                {
                    ulong unix = s.updated;
                    if (unix > 0) title += " — " + _native.FormatRelative((ulong)unix);
                }
                string label = title.Replace('/', '∕');
                // GenericMenu keys items by label, so same-titled conversations would
                // collapse into one row. Append a zero-width space until the label is
                // unique: it's a format char (not whitespace), so unlike a trailing
                // space it survives the menu's trimming, and it's invisible so the
                // titles still read identically to the user.
                while (!used.Add(label)) label += "\u200B";

                bool isCurrent = s.id == _claudeSessionId;
                if (!isCurrent && BusyIds().Contains(s.id))
                {
                    // Open in another process: shown but not selectable.
                    menu.AddDisabledItem(new GUIContent(label));
                }
                else
                {
                    string id = s.id;
                    string t = s.title;
                    menu.AddItem(new GUIContent(label), isCurrent, () => SwitchTo(id, t));
                }
            }

            // Full-text search over every session for this project (not just the
            // recent few), in the transcript area.
            menu.AddSeparator("");
            menu.AddItem(new GUIContent("All Sessions…"), false, EnterBrowse);
            menu.DropDown(activator);
        }

        // Replace this window's conversation with session `id` (resumed). `title`
        // is the picker's known (ai-)title for it; set it on the tab right away,
        // since resuming reuses an id we already hold so the per-tick title sync
        // (gated on the id changing) wouldn't fire.
        // Leaving the current conversation destroys its `claude` process. If a turn
        // is mid-flight, that stops it — confirm first so it isn't lost silently.
        private bool ConfirmLeaveRunningTurn()
        {
            if (_native == null || _viewId == 0 || !_native.AgentviewThinking(Vid)) return true;
            return EditorUtility.DisplayDialog(
                "Turn in progress",
                "This conversation is still running. Leaving it will stop the current turn. Continue?",
                "Leave", "Stay");
        }

        private void SwitchTo(string id, string title = null)
        {
            if (_native == null || string.IsNullOrEmpty(id)) return;
            // Selecting the session already open just leaves the browser.
            if (id == _claudeSessionId) { ExitBrowse(); return; }
            if (!ConfirmLeaveRunningTurn()) return;
            // The destroyed view takes its browser with it; the fresh one below
            // starts on the transcript. (Opening an archived session unarchives
            // it natively — see the browser's resume path.)
            _browsing = false;
            if (_viewId != 0) _native.AgentviewDestroy(Vid);
            _claudeSessionId = id;
            _scroll = 0f;
            var (pw, ph) = CurrentPanelSize();
            var (iw, ih) = CurrentInputSize();
            _viewId = (long)_native.AgentviewLoad(ProjectRoot, id, pw, ph, iw, ih, _effort, ClaudeCode.ClaudePath);
            if (!string.IsNullOrEmpty(title))
                titleContent = UntermWindowTitle.Create(title, UntermWindowTitle.AgentIcon, titleContent);
            ApplyFonts();
            ApplyAgentSettings();
            RenderView(); Repaint();
        }

        // Start a brand-new conversation in this window.
        private void NewSession()
        {
            if (_native == null) return;
            if (!ConfirmLeaveRunningTurn()) return;
            _browsing = false; // the destroyed view takes its browser with it
            if (_viewId != 0) _native.AgentviewDestroy(Vid);
            _claudeSessionId = "";
            _scroll = 0f;
            var (pw, ph) = CurrentPanelSize();
            var (iw, ih) = CurrentInputSize();
            _viewId = (long)_native.AgentviewCreate(ProjectRoot, pw, ph, iw, ih, _effort, ClaudeCode.ClaudePath);
            ApplyFonts();
            ApplyAgentSettings();
            RenderView(); Repaint();
        }

        // --- Agent settings: permission mode / model / reasoning effort ---------

        // Push the persisted settings onto the native view (after a (re)create/load
        // or a domain-reload re-adopt). Idempotent: the native side stores them and
        // re-applies mode/model once the engine finishes initializing.
        private void ApplyAgentSettings()
        {
            if (_native == null || _viewId == 0) return;
            if (!IsAllowedPermissionMode(_permissionMode)) _permissionMode = "default";
            _native.AgentviewSetPermissionMode(Vid, _permissionMode);
            _native.AgentviewSetModel(Vid, _modelSelection);
            // Effort is applied at spawn (--effort), not here.
        }

        private void SetPermissionMode(string mode)
        {
            if (!IsAllowedPermissionMode(mode))
            {
                Debug.LogWarning("[Unterm] Rejected unsupported Claude permission mode: " + mode);
                return;
            }
            _permissionMode = mode;
            if (_native != null && _viewId != 0) _native.AgentviewSetPermissionMode(Vid, mode);
            Repaint();
        }

        /// <summary>Whether a permission mode preserves interactive authorization.</summary>
        private static bool IsAllowedPermissionMode(string mode) =>
            mode == "default" || mode == "auto" || mode == "plan" || mode == "acceptEdits";

        // Shift+Tab cycles only modes that preserve the host authorization boundary.
        private void CyclePermissionMode()
        {
            int i = Array.IndexOf(s_modes, _permissionMode);
            // Skip "auto" when the current model doesn't support it (else Shift+Tab
            // would land on a mode the engine ignores).
            for (int step = 1; step <= s_modes.Length; step++)
            {
                string next = s_modes[(i + step) % s_modes.Length];
                if (next == "auto" && !CurrentModelSupportsAuto()) continue;
                SetPermissionMode(next);
                return;
            }
        }

        private void SetModelSelection(string model)
        {
            _modelSelection = model ?? "";
            if (_native != null && _viewId != 0) _native.AgentviewSetModel(Vid, _modelSelection);
            // Clamp: "auto" isn't valid on a model that doesn't support it (e.g. Haiku),
            // so drop back to "default" when switching to one — as the Zed adapter does.
            if (_permissionMode == "auto" && !CurrentModelSupportsAuto())
                SetPermissionMode("default");
            Repaint();
        }

        // Reasoning effort is a spawn-time flag, so changing it respawns claude,
        // resuming the same conversation (its transcript rebuilds from the jsonl) so
        // context is kept. A fresh, never-talked-to window just recreates.
        private void SetEffort(string effort)
        {
            effort ??= "";
            if ((_effort ?? "") == effort) return;
            _effort = effort;
            Respawn();
        }

        private void Respawn()
        {
            if (_native == null) return;
            if (_viewId != 0) _native.AgentviewDestroy(Vid);
            _scroll = 0f;
            var (pw, ph) = CurrentPanelSize();
            var (iw, ih) = CurrentInputSize();
            _viewId = string.IsNullOrEmpty(_claudeSessionId)
                ? (long)_native.AgentviewCreate(ProjectRoot, pw, ph, iw, ih, _effort, ClaudeCode.ClaudePath)
                : (long)_native.AgentviewLoad(ProjectRoot, _claudeSessionId, pw, ph, iw, ih, _effort, ClaudeCode.ClaudePath);
            ApplyFonts();
            ApplyAgentSettings();
            RenderView(); Repaint();
        }

        private string ModeLabel() => _permissionMode switch
        {
            "auto" => "Auto",
            "plan" => "Plan",
            "acceptEdits" => "Accept",
            _ => "Default",
        };

        // Model: just "Default" when not pinned (don't resolve to the running model);
        // otherwise the engine's own display name for the pinned value (e.g. "Fable"
        // for "claude-fable-5[1m]"), falling back to the capitalized alias.
        private string ModelLabel()
        {
            if (string.IsNullOrEmpty(_modelSelection)) return "Default";
            foreach (var mi in Models())
                if (ModelKey(mi.value) == ModelKey(_modelSelection) && !string.IsNullOrEmpty(mi.displayName))
                    return mi.displayName;
            return Cap(_modelSelection);
        }

        // Match models ignoring a trailing variant suffix like "[1m]": the session log
        // records only the base id, so a resumed roster drops the suffix a fresh one
        // carries — without this, a pinned "…[1m]" stops matching its roster entry.
        private static string ModelKey(string v)
        {
            if (string.IsNullOrEmpty(v)) return "";
            if (v.EndsWith("]"))
            {
                int i = v.LastIndexOf('[');
                if (i >= 0) return v.Substring(0, i);
            }
            return v;
        }

        // Whether the current model advertises auto permission mode (Fable/Opus yes,
        // Haiku no). The engine reports this per model in the roster; gate the "Auto"
        // mode on it the way the Zed adapter does. False until the roster loads.
        private bool CurrentModelSupportsAuto()
        {
            string sel = string.IsNullOrEmpty(_modelSelection) ? "default" : _modelSelection;
            foreach (var mi in Models())
                if (ModelKey(mi.value) == ModelKey(sel))
                    return mi.supportsAutoMode;
            return false;
        }

        // One entry of the engine's advertised model roster (extra fields like
        // supportedEffortLevels are present in the JSON but unused here — JsonUtility
        // ignores them).
        [Serializable] private struct ModelInfo { public string value; public string displayName; public bool supportsAutoMode; }
        [Serializable] private struct ModelList { public ModelInfo[] items; }

        private string _modelsJson;
        private ModelInfo[] _modelsCache = Array.Empty<ModelInfo>();

        // The model roster the engine advertised in its `initialize` reply, parsed and
        // cached (re-parsed only when the native JSON string changes). Empty until the
        // engine is ready — the picker shows a "loading" placeholder in that window.
        private ModelInfo[] Models()
        {
            if (_native == null || _viewId == 0) return Array.Empty<ModelInfo>();
            string json = _native.AgentviewModels(Vid);
            if (json != _modelsJson)
            {
                _modelsJson = json;
                _modelsCache = Array.Empty<ModelInfo>();
                if (!string.IsNullOrEmpty(json))
                {
                    // JsonUtility can't parse a bare top-level array — wrap it.
                    try { _modelsCache = JsonUtility.FromJson<ModelList>("{\"items\":" + json + "}").items ?? Array.Empty<ModelInfo>(); }
                    catch { _modelsCache = Array.Empty<ModelInfo>(); }
                }
            }
            return _modelsCache;
        }

        private string EffortLabel() =>
            string.IsNullOrEmpty(_effort) ? "Default" : Cap(_effort);

        // --- Slash-command completion (native popup, host-driven like the editor) ---

        // One entry of the engine's advertised slash-command roster.
        [Serializable] private struct CmdInfo { public string name; public string description; public string argumentHint; public string[] aliases; }
        [Serializable] private struct CmdList { public CmdInfo[] items; }

        private string _commandsJson;
        private CmdInfo[] _commandsCache = Array.Empty<CmdInfo>();

        // The slash-command roster from the engine's `initialize` reply, parsed and
        // cached (re-parsed only when the native JSON changes). Empty until ready.
        private CmdInfo[] Commands()
        {
            if (_native == null || _viewId == 0) return Array.Empty<CmdInfo>();
            string json = _native.AgentviewCommands(Vid);
            if (json != _commandsJson)
            {
                _commandsJson = json;
                _commandsCache = Array.Empty<CmdInfo>();
                if (!string.IsNullOrEmpty(json))
                {
                    try { _commandsCache = JsonUtility.FromJson<CmdList>("{\"items\":" + json + "}").items ?? Array.Empty<CmdInfo>(); }
                    catch { _commandsCache = Array.Empty<CmdInfo>(); }
                }
            }
            return _commandsCache;
        }

        private const int SlashRows = 10;
        private bool _slashOpen;
        private string _slashToken; // token the current list was built for (null = closed)
        private List<string> _slashItems = new List<string>();  // command names to insert
        private List<string> _slashLabels = new List<string>(); // display labels
        private List<char> _slashKinds = new List<char>();       // 'S' = user skill, ' ' = built-in
        private int _slashSel, _slashScroll, _slashPrefixLen;

        // The engine tags a command's source in its description — user/project-defined
        // ones (the user's own skills/commands) end with "(user)"/"(project)"; built-ins
        // carry no such tag. Used to group and colour them.
        private static bool IsSkillCommand(CmdInfo c)
        {
            string d = c.description?.TrimEnd();
            return !string.IsNullOrEmpty(d) && (d.EndsWith("(user)") || d.EndsWith("(project)"));
        }
        private float _popupAnchorX, _popupAnchorTopY, _popupScale = 1f;

        // Re-evaluate the `/command` popup from the composer's caret context. Cheap;
        // called every repaint. Rebuilds (and resets selection) only when the typed
        // token changes — arrow-key nav re-pushes without rebuilding.
        private void UpdateSlashCompletion()
        {
            if (_native == null || _viewId == 0 || !_native.PopupAvailable) { CloseSlash(); return; }
            // While browsing, the composer is a search box — `/` is just text.
            if (_browsing) { CloseSlash(); return; }
            // The popup is a separate OS window; OnGUI keeps running (and would re-open
            // it) while this window is in the background, so gate on focus here rather
            // than relying on OnLostFocus alone.
            if (focusedWindow != this) { CloseSlash(); return; }
            string sp = _native.AgentviewInputSlashPrefix(Vid); // "/token" or ""
            if (string.IsNullOrEmpty(sp) || sp[0] != '/') { CloseSlash(); return; }
            string token = sp.Substring(1);
            if (_slashOpen && token == _slashToken) return; // already showing for this token
            var cmds = Commands();
            if (cmds.Length == 0) { CloseSlash(); return; }
            var matched = new List<CmdInfo>();
            foreach (var c in cmds)
                if (SlashMatches(c, token)) matched.Add(c);
            if (matched.Count == 0) { CloseSlash(); return; }
            // Group the user's own skills/commands first, then built-ins, each sorted
            // by name — so the list is predictable and the two kinds stay grouped.
            matched.Sort((a, b) =>
            {
                bool sa = IsSkillCommand(a), sb = IsSkillCommand(b);
                if (sa != sb) return sa ? -1 : 1;
                return string.Compare(a.name, b.name, StringComparison.OrdinalIgnoreCase);
            });
            var items = new List<string>(matched.Count);
            var labels = new List<string>(matched.Count);
            var kinds = new List<char>(matched.Count);
            foreach (var c in matched)
            {
                items.Add(c.name);
                labels.Add(string.IsNullOrEmpty(c.argumentHint) ? c.name : c.name + "  " + c.argumentHint);
                kinds.Add(IsSkillCommand(c) ? 'S' : ' '); // 'S' accents user skills; ' ' = built-in default
            }
            _slashItems = items;
            _slashLabels = labels;
            _slashKinds = kinds;
            _slashToken = token;
            _slashPrefixLen = token.Length;
            _slashSel = 0;
            _slashScroll = 0;
            _slashOpen = true;
            PushSlash();
        }

        private static bool SlashMatches(CmdInfo c, string token)
        {
            if (token.Length == 0) return true;
            if (!string.IsNullOrEmpty(c.name) && c.name.StartsWith(token, StringComparison.OrdinalIgnoreCase)) return true;
            if (c.aliases != null)
                foreach (var a in c.aliases)
                    if (!string.IsNullOrEmpty(a) && a.StartsWith(token, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        // Push the popup state to the native OS window, anchored above the composer.
        private void PushSlash()
        {
            if (_native == null || _viewId == 0) return;
            if (!_slashOpen) { _native.PopupHide(); return; }
            var sb = new System.Text.StringBuilder();
            for (int i = 0; i < _slashLabels.Count; i++)
            {
                if (i > 0) sb.Append('\n');
                // Leading kind tag colours the row: 'S' accents user skills, ' ' is the
                // built-in default. Both render a '·' bullet, not a letter badge.
                sb.Append(i < _slashKinds.Count ? _slashKinds[i] : ' ').Append(_slashLabels[i]);
            }
            int vis = Mathf.Min(_slashItems.Count, SlashRows);
            _slashScroll = Mathf.Clamp(_slashScroll, 0, Mathf.Max(0, _slashItems.Count - vis));
            bool dark = EditorGUIUtility.isProSkin;
            Color32 fg = dark ? new Color32(210, 210, 214, 255) : new Color32(32, 32, 32, 255);
            _native.PopupShowAbove(sb.ToString(), (uint)_slashSel, (uint)_slashScroll,
                _popupAnchorX, _popupAnchorTopY, _popupScale, GetEditorBackground().linear, fg, dark);
        }

        private void CloseSlash()
        {
            if (!_slashOpen && _slashToken == null) return;
            _slashOpen = false;
            _slashToken = null;
            _slashSel = 0;
            _slashScroll = 0;
            if (_native != null) _native.PopupHide();
        }

        private void EnsureSlashVisible()
        {
            int vis = Mathf.Min(_slashItems.Count, SlashRows);
            if (_slashSel < _slashScroll) _slashScroll = _slashSel;
            else if (_slashSel >= _slashScroll + vis) _slashScroll = _slashSel - vis + 1;
        }

        // Insert the selected command with a trailing space, so the popup dismisses
        // and the caret is ready for arguments.
        private void AcceptSlash()
        {
            if (!_slashOpen || _slashItems.Count == 0) { CloseSlash(); return; }
            string name = _slashItems[Mathf.Clamp(_slashSel, 0, _slashItems.Count - 1)];
            _native.AgentviewInputComplete(Vid, (uint)_slashPrefixLen, name + " ");
            CloseSlash();
            RenderView();
            Repaint();
        }

        private static string Cap(string s) =>
            string.IsNullOrEmpty(s) ? s : char.ToUpperInvariant(s[0]) + s.Substring(1);

        // Each control is its own dropdown of mutually-exclusive checked items,
        // anchored at the cursor (ShowAsContext) so it drops under its button.
        private void ShowModeMenu()
        {
            var m = new GenericMenu();
            m.AddItem(new GUIContent("Default (ask)"), _permissionMode == "default", () => SetPermissionMode("default"));
            // "Auto" (a model classifier approves/denies prompts) only works on models
            // that advertise it — offer it only there, like the Zed adapter.
            if (CurrentModelSupportsAuto())
                m.AddItem(new GUIContent("Auto"), _permissionMode == "auto", () => SetPermissionMode("auto"));
            m.AddItem(new GUIContent("Plan"), _permissionMode == "plan", () => SetPermissionMode("plan"));
            m.AddItem(new GUIContent("Accept edits"), _permissionMode == "acceptEdits", () => SetPermissionMode("acceptEdits"));
            m.ShowAsContext();
        }

        private void ShowModelMenu()
        {
            var m = new GenericMenu();
            var models = Models();
            if (models.Length == 0)
            {
                // The engine hasn't advertised its roster yet (brief startup window
                // before `initialize` returns). Show a disabled placeholder rather
                // than a hardcoded alias list that could mismatch the account.
                m.AddDisabledItem(new GUIContent("Loading models…"));
            }
            foreach (var mi in models)
            {
                // The engine reports its default row as value "default"; Unterm
                // stores the default selection as "" (empty), so map it back.
                string val = mi.value == "default" ? "" : mi.value;
                string label = string.IsNullOrEmpty(mi.displayName) ? mi.value : mi.displayName;
                m.AddItem(new GUIContent(label), ModelKey(_modelSelection) == ModelKey(val), () => SetModelSelection(val));
            }
            m.ShowAsContext();
        }

        private void ShowEffortMenu()
        {
            string e = _effort ?? "";
            var m = new GenericMenu();
            m.AddItem(new GUIContent("Default (model default)"), e == "", () => SetEffort(""));
            m.AddItem(new GUIContent("None"), e == "none", () => SetEffort("none"));
            m.AddItem(new GUIContent("Low"), e == "low", () => SetEffort("low"));
            m.AddItem(new GUIContent("Medium"), e == "medium", () => SetEffort("medium"));
            m.AddItem(new GUIContent("High"), e == "high", () => SetEffort("high"));
            m.AddItem(new GUIContent("Max"), e == "max", () => SetEffort("max"));
            m.ShowAsContext();
        }
    }
}
