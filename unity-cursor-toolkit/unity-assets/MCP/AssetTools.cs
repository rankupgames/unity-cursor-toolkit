// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: MCP tool handlers for asset and material management.
// Created: 2026-03-12
// Last Modified: 2026-03-12
// =============================================================================

#if UNITY_EDITOR

using System;
using UnityEngine;
using UnityEditor;
using UnityCursorToolkit.Core;

namespace UnityCursorToolkit.MCP
{
	[MCPTool("manage_asset")]
	internal sealed class ManageAssetTool : IToolHandler
	{
		public string ToolName => "manage_asset";
		public string Description => "Import, move, rename, delete, or refresh assets.";

		public string HandleCommand(string argsJson)
		{
			var args = AssetToolsHelpers.ParseArgs(argsJson);
			var action = AssetToolsHelpers.GetString(args, "action", "");

			switch (action)
			{
				case "import":
					return Import(AssetToolsHelpers.GetString(args, "path", ""));
				case "move":
					return Move(AssetToolsHelpers.GetString(args, "source", ""), AssetToolsHelpers.GetString(args, "dest", ""));
				case "rename":
					return Rename(AssetToolsHelpers.GetString(args, "path", ""), AssetToolsHelpers.GetString(args, "newName", ""));
				case "delete":
					return Delete(AssetToolsHelpers.GetString(args, "path", ""));
				case "refresh":
					return Refresh();
				default:
					return AssetToolsHelpers.JsonError($"Unknown action: {action}");
			}
		}

		private string Import(string path)
		{
			if (string.IsNullOrEmpty(path))
				return AssetToolsHelpers.JsonError("path is required");
			AssetDatabase.ImportAsset(path);
			return "{\"success\":true,\"path\":\"" + AssetToolsHelpers.Escape(path) + "\"}";
		}

		private string Move(string source, string dest)
		{
			if (string.IsNullOrEmpty(source))
				return AssetToolsHelpers.JsonError("source is required");
			if (string.IsNullOrEmpty(dest))
				return AssetToolsHelpers.JsonError("dest is required");
			string err = AssetDatabase.MoveAsset(source, dest);
			if (string.IsNullOrEmpty(err) == false)
				return AssetToolsHelpers.JsonError(err);
			return "{\"success\":true,\"path\":\"" + AssetToolsHelpers.Escape(dest) + "\"}";
		}

		private string Rename(string path, string newName)
		{
			if (string.IsNullOrEmpty(path))
				return AssetToolsHelpers.JsonError("path is required");
			if (string.IsNullOrEmpty(newName))
				return AssetToolsHelpers.JsonError("newName is required");
			string err = AssetDatabase.RenameAsset(path, newName);
			if (string.IsNullOrEmpty(err) == false)
				return AssetToolsHelpers.JsonError(err);
			return "{\"success\":true,\"path\":\"" + AssetToolsHelpers.Escape(path) + "\"}";
		}

		private string Delete(string path)
		{
			if (string.IsNullOrEmpty(path))
				return AssetToolsHelpers.JsonError("path is required");
			if (AssetDatabase.DeleteAsset(path) == false)
				return AssetToolsHelpers.JsonError("Failed to delete asset");
			return "{\"success\":true}";
		}

		private string Refresh()
		{
			AssetDatabase.Refresh();
			return "{\"success\":true}";
		}
	}

	[MCPTool("manage_material")]
	internal sealed class ManageMaterialTool : IToolHandler
	{
		public string ToolName => "manage_material";
		public string Description => "Create, setColor, setFloat, or setTexture on materials.";

		public string HandleCommand(string argsJson)
		{
			var args = AssetToolsHelpers.ParseArgs(argsJson);
			var action = AssetToolsHelpers.GetString(args, "action", "");

			switch (action)
			{
				case "create":
					return Create(AssetToolsHelpers.GetString(args, "path", ""), AssetToolsHelpers.GetString(args, "shader", ""));
				case "setColor":
					return SetColor(AssetToolsHelpers.GetString(args, "path", ""), AssetToolsHelpers.GetString(args, "property", ""), args);
				case "setFloat":
					return SetFloat(AssetToolsHelpers.GetString(args, "path", ""), AssetToolsHelpers.GetString(args, "property", ""), AssetToolsHelpers.GetFloat(args, "value", 0f));
				case "setTexture":
					return SetTexture(AssetToolsHelpers.GetString(args, "path", ""), AssetToolsHelpers.GetString(args, "property", ""), AssetToolsHelpers.GetString(args, "texturePath", ""));
				default:
					return AssetToolsHelpers.JsonError($"Unknown action: {action}");
			}
		}

		private string Create(string path, string shaderName)
		{
			if (string.IsNullOrEmpty(path))
				return AssetToolsHelpers.JsonError("path is required");
			var shader = string.IsNullOrEmpty(shaderName) ? Shader.Find("Standard") : Shader.Find(shaderName);
			if (shader == null)
				shader = Shader.Find("Standard");
			var mat = new Material(shader);
			AssetDatabase.CreateAsset(mat, path);
			return "{\"success\":true,\"path\":\"" + AssetToolsHelpers.Escape(path) + "\"}";
		}

		private string SetColor(string path, string property, System.Collections.Generic.Dictionary<string, object> args)
		{
			if (string.IsNullOrEmpty(path))
				return AssetToolsHelpers.JsonError("path is required");
			if (string.IsNullOrEmpty(property))
				return AssetToolsHelpers.JsonError("property is required");
			var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
			if (mat == null)
				return AssetToolsHelpers.JsonError("Material not found");
			var arr = AssetToolsHelpers.GetFloatArray(args, "color");
			if (arr == null || arr.Length < 4)
				return AssetToolsHelpers.JsonError("color array [r,g,b,a] required");
			Undo.RecordObject(mat, "MCP Set Color");
			mat.SetColor(property, new Color(arr[0], arr[1], arr[2], arr[3]));
			EditorUtility.SetDirty(mat);
			return "{\"success\":true}";
		}

		private string SetFloat(string path, string property, float value)
		{
			if (string.IsNullOrEmpty(path))
				return AssetToolsHelpers.JsonError("path is required");
			if (string.IsNullOrEmpty(property))
				return AssetToolsHelpers.JsonError("property is required");
			var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
			if (mat == null)
				return AssetToolsHelpers.JsonError("Material not found");
			Undo.RecordObject(mat, "MCP Set Float");
			mat.SetFloat(property, value);
			EditorUtility.SetDirty(mat);
			return "{\"success\":true}";
		}

		private string SetTexture(string path, string property, string texturePath)
		{
			if (string.IsNullOrEmpty(path))
				return AssetToolsHelpers.JsonError("path is required");
			if (string.IsNullOrEmpty(property))
				return AssetToolsHelpers.JsonError("property is required");
			if (string.IsNullOrEmpty(texturePath))
				return AssetToolsHelpers.JsonError("texturePath is required");
			var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
			if (mat == null)
				return AssetToolsHelpers.JsonError("Material not found");
			var tex = AssetDatabase.LoadAssetAtPath<Texture>(texturePath);
			if (tex == null)
				return AssetToolsHelpers.JsonError("Texture not found");
			Undo.RecordObject(mat, "MCP Set Texture");
			mat.SetTexture(property, tex);
			EditorUtility.SetDirty(mat);
			return "{\"success\":true}";
		}
	}

	internal static class AssetToolsHelpers
	{
		[Serializable]
		private class ArgsWrapper
		{
			public string action;
			public string path;
			public string source;
			public string dest;
			public string newName;
			public string shader;
			public string property;
			public string texturePath;
			public float value;
			public float[] color;
		}

		internal static System.Collections.Generic.Dictionary<string, object> ParseArgs(string json)
		{
			var d = new System.Collections.Generic.Dictionary<string, object>();
			if (string.IsNullOrEmpty(json))
				return d;
			try
			{
				var w = JsonUtility.FromJson<ArgsWrapper>(json);
				if (w != null)
				{
					if (w.action != null) d["action"] = w.action;
					if (w.path != null) d["path"] = w.path;
					if (w.source != null) d["source"] = w.source;
					if (w.dest != null) d["dest"] = w.dest;
					if (w.newName != null) d["newName"] = w.newName;
					if (w.shader != null) d["shader"] = w.shader;
					if (w.property != null) d["property"] = w.property;
					if (w.texturePath != null) d["texturePath"] = w.texturePath;
					d["value"] = w.value;
					if (w.color != null && w.color.Length >= 4) d["color"] = w.color;
				}
			}
			catch { }
			return d;
		}

		internal static string GetString(System.Collections.Generic.Dictionary<string, object> d, string key, string def)
		{
			if (d.TryGetValue(key, out var v) == false || v == null)
				return def;
			return v.ToString();
		}

		internal static float GetFloat(System.Collections.Generic.Dictionary<string, object> d, string key, float def)
		{
			if (d.TryGetValue(key, out var v) == false)
				return def;
			if (v is float f) return f;
			if (v is double db) return (float)db;
			if (v is int i) return (float)i;
			float.TryParse(v.ToString(), out var parsed);
			return parsed;
		}

		internal static float[] GetFloatArray(System.Collections.Generic.Dictionary<string, object> d, string key)
		{
			if (d.TryGetValue(key, out var v) == false)
				return null;
			if (v is float[] fa)
				return fa;
			return null;
		}

		internal static string JsonError(string msg) => "{\"success\":false,\"error\":\"" + Escape(msg) + "\"}";
		internal static string Escape(string s)
		{
			if (s == null) return string.Empty;
			return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
		}
	}
}

#endif
