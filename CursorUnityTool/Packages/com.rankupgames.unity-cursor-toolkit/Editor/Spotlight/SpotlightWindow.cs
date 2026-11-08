#if UNITY_EDITOR

using UnityEditor;
using UnityEditor.ShortcutManagement;
using UnityEngine;

namespace UnityCursorToolkit.Spotlight
{
	internal sealed class SpotlightWindow : EditorWindow
	{
		private const float PaletteWidth = 640;
		private const float QueryHeight = 56;
		private const float RowHeight = 48;
		private const int VisibleRows = 8;
		private const string QueryControl = "ToolkitSpotlightQuery";
		private static readonly Color Panel = new Color32(41, 41, 41, 255);
		private static readonly Color InputSurface = new Color32(37, 37, 37, 255);
		private static readonly Color Line = new Color32(73, 73, 73, 255);
		private static readonly Color Ink = new Color32(242, 242, 242, 255);
		private static readonly Color Muted = new Color32(184, 184, 184, 255);
		private static readonly Color Selected = new Color32(36, 78, 120, 255);
		private static readonly Color Focus = new Color32(100, 169, 238, 255);
		private SpotlightSearch search;
		private SpotlightResult selected;
		private EditorWindow previousWindow;
		private string query = string.Empty;
		private string actionError;
		private double searchAt;
		private Vector2 scroll;
		private bool focusQuery;
		private int lastResultCount, lastErrorCount;
		private bool lastSearching;
		private GUIStyle queryStyle, titleStyle, descriptionStyle, selectedDescriptionStyle, actionStyle, errorStyle;
		private GUIStyle panelStyle, inputStyle, focusedStyle;
		private Texture2D panelTexture, inputTexture, focusTexture;

		[MenuItem("Tools/Unity Cursor Toolkit/Spotlight")]
		[Shortcut("Unity Cursor Toolkit/Spotlight", KeyCode.K, ShortcutModifiers.Action | ShortcutModifiers.Shift)]
		private static void OpenPalette()
		{
			foreach (var existing in Resources.FindObjectsOfTypeAll<SpotlightWindow>())
			{
				existing.focusQuery = true;
				existing.Focus();
				return;
			}
			var owner = focusedWindow;
			var palette = CreateInstance<SpotlightWindow>();
			palette.previousWindow = owner;
			palette.titleContent = new GUIContent("Spotlight");
			var area = owner != null ? owner.position : new Rect(0, 0,
				Screen.currentResolution.width / EditorGUIUtility.pixelsPerPoint,
				Screen.currentResolution.height / EditorGUIUtility.pixelsPerPoint);
			palette.position = new Rect(area.center.x - PaletteWidth / 2, area.y + Mathf.Min(160, area.height * .2f), PaletteWidth, QueryHeight);
			palette.ShowPopup();
			palette.Focus();
		}

		private void OnEnable()
		{
			focusQuery = true;
			wantsMouseMove = true;
			EditorApplication.update += UpdateSearch;
		}

		private void OnDisable()
		{
			EditorApplication.update -= UpdateSearch;
			search?.Dispose();
			search = null;
			if (panelTexture != null) DestroyImmediate(panelTexture);
			if (inputTexture != null) DestroyImmediate(inputTexture);
			if (focusTexture != null) DestroyImmediate(focusTexture);
			queryStyle = null;
		}

		private void BeginSearch()
		{
			search?.Dispose();
			search = null;
			selected = null;
			actionError = null;
			scroll = Vector2.zero;
			searchAt = EditorApplication.timeSinceStartup + .12;
			Resize();
		}

		private void UpdateSearch()
		{
			if (search == null && !string.IsNullOrWhiteSpace(query) && EditorApplication.timeSinceStartup >= searchAt)
				search = new SpotlightSearch(query);
			if (search == null) return;
			search.Tick();
			Resize();
			if (search.IsSearching || lastSearching != search.IsSearching || lastResultCount != search.Results.Count || lastErrorCount != search.Errors.Count)
				Repaint();
			lastSearching = search.IsSearching;
			lastResultCount = search.Results.Count;
			lastErrorCount = search.Errors.Count;
		}

		private bool IsSearching => !string.IsNullOrWhiteSpace(query) && (search == null || search.IsSearching);
		private string Error => !string.IsNullOrEmpty(actionError) ? actionError
			: search != null && search.Errors.Count > 0 ? search.Errors[0] : null;

		private void Resize()
		{
			int count = search == null ? 0 : search.Results.Count;
			bool status = IsSearching || !string.IsNullOrEmpty(Error) || (count == 0 && !string.IsNullOrWhiteSpace(query));
			float height = QueryHeight + Mathf.Min(count, VisibleRows) * RowHeight + (status ? RowHeight : 0);
			if (Mathf.Approximately(position.height, height) && Mathf.Approximately(position.width, PaletteWidth)) return;
			minSize = maxSize = new Vector2(PaletteWidth, height);
			position = new Rect(position.x, position.y, PaletteWidth, height);
		}

		private SpotlightResult SelectedResult => selected ?? (search != null && search.Results.Count > 0 ? search.Results[0] : null);

		private void OnGUI()
		{
			EnsureStyles();
			HandleKeyboard();
			if (Event.current.type == EventType.Repaint)
			{
				var bounds = new Rect(0, 0, position.width, position.height);
				(string.IsNullOrWhiteSpace(query) ? focusedStyle : panelStyle).Draw(bounds, GUIContent.none, false, false, false, false);
				inputStyle.Draw(new Rect(1, 1, position.width - 2, QueryHeight - 1), GUIContent.none, false, false, false, false);
				EditorGUI.DrawRect(new Rect(1, QueryHeight - 8, position.width - 2, 8), InputSurface);
				if (position.height > QueryHeight) EditorGUI.DrawRect(new Rect(1, QueryHeight, position.width - 2, 1), Line);
			}
			GUI.SetNextControlName(QueryControl);
			string nextQuery = EditorGUI.TextField(new Rect(20, 12, position.width - 40, 28), query, queryStyle);
			if (nextQuery != query) { query = nextQuery; BeginSearch(); }
			if (query.Length == 0 && Event.current.type == EventType.Repaint)
				GUI.Label(new Rect(23, 12, position.width - 40, 28), "Search Unity", new GUIStyle(queryStyle) { normal = { textColor = Muted } });
			if (focusQuery)
			{
				GUI.FocusControl(QueryControl);
				focusQuery = false;
			}
			DrawResults();
			DrawStatus();
			if (Event.current.type == EventType.MouseMove) Repaint();
		}

		private void HandleKeyboard()
		{
			var current = Event.current;
			if (current.type != EventType.KeyDown || !string.IsNullOrEmpty(UnityEngine.Input.compositionString)) return;
			if (current.keyCode == KeyCode.Escape)
			{
				current.Use();
				Close();
				if (previousWindow != null) previousWindow.Focus();
				GUIUtility.ExitGUI();
			}
			if (current.keyCode == KeyCode.Return || current.keyCode == KeyCode.KeypadEnter)
			{
				current.Use();
				var result = SelectedResult;
				if (result != null && result.IsAvailable) Execute(result, result.DefaultAction);
			}
			else if (current.keyCode == KeyCode.UpArrow || current.keyCode == KeyCode.DownArrow)
			{
				current.Use();
				if (search == null || search.Results.Count == 0) return;
				int index = search.Results.IndexOf(SelectedResult);
				index = Mathf.Clamp(index + (current.keyCode == KeyCode.DownArrow ? 1 : -1), 0, search.Results.Count - 1);
				selected = search.Results[index];
				scroll.y = Mathf.Clamp(scroll.y, (index + 1) * RowHeight - VisibleRows * RowHeight, index * RowHeight);
				Repaint();
			}
			else if (current.keyCode == KeyCode.F10 && current.shift)
			{
				current.Use();
				if (SelectedResult != null) ShowActions(SelectedResult);
			}
		}

		private void DrawResults()
		{
			if (search == null || search.Results.Count == 0) return;
			float height = Mathf.Min(search.Results.Count, VisibleRows) * RowHeight;
			float width = position.width - 2 - (search.Results.Count > VisibleRows ? 16 : 0);
			scroll = GUI.BeginScrollView(new Rect(1, QueryHeight + 1, position.width - 2, height), scroll,
				new Rect(0, 0, width, search.Results.Count * RowHeight), false, false);
			int first = Mathf.Max(0, Mathf.FloorToInt(scroll.y / RowHeight));
			int end = Mathf.Min(search.Results.Count, first + VisibleRows + 1);
			for (int index = first; index < end; index++)
			{
				var result = search.Results[index];
				var row = new Rect(0, index * RowHeight, width, RowHeight);
				bool isSelected = result == SelectedResult;
				bool hovered = row.Contains(Event.current.mousePosition);
				if (Event.current.type == EventType.Repaint && (isSelected || hovered))
					EditorGUI.DrawRect(row, isSelected ? Selected : new Color32(52, 52, 52, 255));
				Texture icon = result.Target is EditorWindow window ? window.titleContent.image
					: result.Target != null ? AssetPreview.GetMiniThumbnail(result.Target) : EditorGUIUtility.IconContent("SettingsIcon").image;
				if (icon != null) GUI.DrawTexture(new Rect(12, row.y + 14, 20, 20), icon, ScaleMode.ScaleToFit);
				float textWidth = width - 56 - 108;
				GUI.Label(new Rect(44, row.y + 9, textWidth, 16), new GUIContent(result.Title, result.Description), result.IsAvailable ? titleStyle : descriptionStyle);
				string description = result.IsAvailable ? result.Description : "No longer available · " + result.Description;
				GUI.Label(new Rect(44, row.y + 27, textWidth, 14), new GUIContent(description, description), isSelected ? selectedDescriptionStyle : descriptionStyle);
				using (new EditorGUI.DisabledScope(!result.IsAvailable))
				{
					if (isSelected && GUI.Button(new Rect(width - 108, row.y + 12, 72, 24), result.DefaultAction.ToString(), actionStyle)) Execute(result, result.DefaultAction);
					var menuIcon = new GUIContent(EditorGUIUtility.IconContent("_Popup")) { tooltip = "Result actions" };
					if (isSelected && GUI.Button(new Rect(width - 36, row.y + 12, 24, 24), menuIcon, GUIStyle.none)) ShowActions(result);
				}
				if (hovered && (Event.current.type == EventType.MouseDown || Event.current.type == EventType.ContextClick))
				{
					selected = result;
					bool execute = Event.current.button == 0 && Event.current.clickCount == 2;
					bool context = Event.current.type == EventType.ContextClick;
					Event.current.Use();
					if (context) ShowActions(result);
					else if (execute && result.IsAvailable) Execute(result, result.DefaultAction);
					Repaint();
				}
			}
			GUI.EndScrollView();
		}

		private void DrawStatus()
		{
			int count = search == null ? 0 : search.Results.Count;
			string error = Error;
			string message = !string.IsNullOrEmpty(error) ? error : IsSearching ? "Searching..."
				: count == 0 && !string.IsNullOrWhiteSpace(query) ? "No results" : null;
			if (message == null) return;
			float y = QueryHeight + Mathf.Min(count, VisibleRows) * RowHeight;
			GUI.Label(new Rect(20, y + 8, position.width - (error == null ? 40 : 112), 32), new GUIContent(message, message), error == null ? descriptionStyle : errorStyle);
			if (error != null && GUI.Button(new Rect(position.width - 76, y + 10, 56, 28), "Retry")) BeginSearch();
		}

		private void ShowActions(SpotlightResult result)
		{
			var menu = new GenericMenu();
			foreach (var action in result.Actions)
			{
				var selectedAction = action;
				if (result.IsAvailable) menu.AddItem(new GUIContent(action.ToString()), false, () => Execute(result, selectedAction));
				else menu.AddDisabledItem(new GUIContent(action.ToString()));
			}
			menu.ShowAsContext();
		}

		private void Execute(SpotlightResult result, SpotlightAction action)
		{
			// Contextual menu commands belong to the view that opened the palette.
			if (action == SpotlightAction.Execute && previousWindow != null) previousWindow.Focus();
			var outcome = result.Execute(action);
			actionError = outcome.Message;
			if (outcome.Success)
			{
				Close();
				if (Event.current != null) GUIUtility.ExitGUI();
			}
			else { Focus(); Resize(); Repaint(); }
		}

		private void EnsureStyles()
		{
			if (queryStyle != null) return;
			queryStyle = TextStyle(20, Ink);
			queryStyle.alignment = TextAnchor.MiddleLeft;
			queryStyle.padding = new RectOffset(0, 0, 0, 0);
			titleStyle = TextStyle(13, Ink);
			descriptionStyle = TextStyle(11, Muted);
			selectedDescriptionStyle = TextStyle(11, new Color32(215, 231, 247, 255));
			actionStyle = TextStyle(11, Ink);
			actionStyle.alignment = TextAnchor.MiddleRight;
			errorStyle = TextStyle(11, new Color32(239, 170, 170, 255));
			errorStyle.wordWrap = true;
			panelTexture = RoundedTexture(Panel, Line);
			inputTexture = RoundedTexture(InputSurface, InputSurface);
			focusTexture = RoundedTexture(Panel, Focus);
			panelStyle = new GUIStyle { normal = { background = panelTexture }, border = new RectOffset(9, 9, 9, 9) };
			inputStyle = new GUIStyle { normal = { background = inputTexture }, border = new RectOffset(9, 9, 9, 9) };
			focusedStyle = new GUIStyle(panelStyle) { normal = { background = focusTexture } };
		}

		private static GUIStyle TextStyle(int size, Color color)
		{
			return new GUIStyle(EditorStyles.label) { fontSize = size, richText = false, padding = new RectOffset(),
				normal = { textColor = color, background = null }, hover = { textColor = color, background = null },
				focused = { textColor = color, background = null }, active = { textColor = color, background = null } };
		}

		private static Texture2D RoundedTexture(Color fill, Color border)
		{
			var texture = new Texture2D(20, 20, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave };
			for (int y = 0; y < 20; y++)
				for (int x = 0; x < 20; x++)
				{
					float dx = Mathf.Max(8 - (x + .5f), (x + .5f) - 12, 0);
					float dy = Mathf.Max(8 - (y + .5f), (y + .5f) - 12, 0);
					float distance = Mathf.Sqrt(dx * dx + dy * dy);
					float edge = Mathf.Min(x + .5f, 19.5f - x, y + .5f, 19.5f - y);
					Color color = distance > 7 || edge < 1 ? border : fill;
					color.a *= Mathf.Clamp01(8 - distance);
					texture.SetPixel(x, y, color);
				}
			texture.Apply();
			return texture;
		}
	}
}

#endif
