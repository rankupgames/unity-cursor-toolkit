// =============================================================================
// Author: Miguel A. Lopez
// Company: Rank Up Games LLC
// Project: Unity Cursor Toolkit
// Description: MCP tool handlers for scene, GameObject, and component management.
// Created: 2026-03-12
// Last Modified: 2026-03-12
// =============================================================================

#if UNITY_EDITOR

using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityCursorToolkit.Core;

namespace UnityCursorToolkit.MCP
{
	internal static class EditorUtilityCompat
	{
		/// <summary>
		/// Version-safe wrapper for InstanceIDToObject / EntityIdToObject.
		/// </summary>
		internal static UnityEngine.Object IDToObject(int instanceId)
		{
#if UNITY_6000_0_OR_NEWER
			return EditorUtility.EntityIdToObject(instanceId);
#else
			#pragma warning disable CS0618
			return EditorUtility.InstanceIDToObject(instanceId);
			#pragma warning restore CS0618
#endif
		}
	}

	// -----------------------------------------------------------------------------
	// manage_scene
	// -----------------------------------------------------------------------------

	[MCPTool("manage_scene")]
	internal sealed class ManageSceneTool : IToolHandler
	{
		public string ToolName => "manage_scene";
		public string Description => "Get hierarchy, load, save, or create scenes.";

		public string HandleCommand(string argsJson)
		{
			var args = SceneToolsHelpers.ParseArgs(argsJson);
			var action = SceneToolsHelpers.GetString(args, "action", "");

			switch (action)
			{
				case "getHierarchy":
					return GetHierarchy();
				case "load":
					return LoadScene(SceneToolsHelpers.GetString(args, "path", ""));
				case "save":
					return SaveScene();
				case "create":
					return CreateScene(SceneToolsHelpers.GetString(args, "path", ""));
				default:
					return SceneToolsHelpers.JsonError($"Unknown action: {action}");
			}
		}

		private string GetHierarchy()
		{
			var rootObjects = UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects();
			var sb = new StringBuilder();
			sb.Append("{\"roots\":[");
			for (int i = 0; i < rootObjects.Length; i++)
			{
				if (i > 0) sb.Append(",");
				sb.Append(SerializeGameObject(rootObjects[i]));
			}
			sb.Append("]}");
			return sb.ToString();
		}

		private string SerializeGameObject(GameObject go)
		{
			var sb = new StringBuilder();
			sb.Append("{\"name\":\"").Append(SceneToolsHelpers.Escape(go.name)).Append("\",\"instanceId\":").Append(go.GetInstanceID()).Append(",\"children\":[");
			var children = new List<Transform>();
			foreach (Transform t in go.transform)
				children.Add(t);
			for (int i = 0; i < children.Count; i++)
			{
				if (i > 0) sb.Append(",");
				sb.Append(SerializeGameObject(children[i].gameObject));
			}
			sb.Append("]}");
			return sb.ToString();
		}

		private string LoadScene(string path)
		{
			if (string.IsNullOrEmpty(path))
				return SceneToolsHelpers.JsonError("path is required");
			var scene = EditorSceneManager.OpenScene(path, OpenSceneMode.Single);
			return "{\"success\":true,\"path\":\"" + SceneToolsHelpers.Escape(scene.path) + "\"}";
		}

		private string SaveScene()
		{
			var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
			if (scene.isDirty == false)
				return "{\"success\":true,\"saved\":false,\"path\":\"" + SceneToolsHelpers.Escape(scene.path) + "\"}";
			EditorSceneManager.SaveScene(scene);
			return "{\"success\":true,\"saved\":true,\"path\":\"" + SceneToolsHelpers.Escape(scene.path) + "\"}";
		}

		private string CreateScene(string path)
		{
			if (string.IsNullOrEmpty(path))
				return SceneToolsHelpers.JsonError("path is required");
			var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
			EditorSceneManager.SaveScene(scene, path);
			return "{\"success\":true,\"path\":\"" + SceneToolsHelpers.Escape(path) + "\"}";
		}

		// -----------------------------------------------------------------------------
		// manage_gameobject
		// -----------------------------------------------------------------------------
	}

	[MCPTool("manage_gameobject")]
	internal sealed class ManageGameObjectTool : IToolHandler
	{
		public string ToolName => "manage_gameobject";
		public string Description => "Create, find, destroy, setTransform, or setParent on GameObjects.";

		public string HandleCommand(string argsJson)
		{
			var args = SceneToolsHelpers.ParseArgs(argsJson);
			var action = SceneToolsHelpers.GetString(args, "action", "");

			switch (action)
			{
				case "create":
					return Create(SceneToolsHelpers.GetString(args, "name", "GameObject"));
				case "find":
					return Find(SceneToolsHelpers.GetString(args, "name", ""), SceneToolsHelpers.GetInt(args, "instanceId", -1));
				case "destroy":
					return Destroy(SceneToolsHelpers.GetInt(args, "instanceId", -1));
				case "setTransform":
					return SetTransform(args);
				case "setParent":
					return SetParent(SceneToolsHelpers.GetInt(args, "instanceId", -1), SceneToolsHelpers.GetInt(args, "parentInstanceId", -1));
				default:
					return SceneToolsHelpers.JsonError($"Unknown action: {action}");
			}
		}

		private string Create(string name)
		{
			var go = new GameObject(name ?? "GameObject");
			Undo.RegisterCreatedObjectUndo(go, "MCP Create GameObject");
			return "{\"success\":true,\"instanceId\":" + go.GetInstanceID() + "}";
		}

		private string Find(string name, int instanceId)
		{
			GameObject go = null;
			if (instanceId >= 0)
				go = (GameObject)EditorUtilityCompat.IDToObject(instanceId);
			else if (string.IsNullOrEmpty(name) == false)
				go = GameObject.Find(name);
			if (go == null)
				return SceneToolsHelpers.JsonError("GameObject not found");
			return "{\"success\":true,\"instanceId\":" + go.GetInstanceID() + ",\"name\":\"" + SceneToolsHelpers.Escape(go.name) + "\"}";
		}

		private string Destroy(int instanceId)
		{
			if (instanceId < 0)
				return SceneToolsHelpers.JsonError("instanceId is required");
			var go = (GameObject)EditorUtilityCompat.IDToObject(instanceId);
			if (go == null)
				return SceneToolsHelpers.JsonError("GameObject not found");
			Undo.DestroyObjectImmediate(go);
			return "{\"success\":true}";
		}

		private string SetTransform(Dictionary<string, object> args)
		{
			var instanceId = SceneToolsHelpers.GetInt(args, "instanceId", -1);
			if (instanceId < 0)
				return SceneToolsHelpers.JsonError("instanceId is required");
			var go = (GameObject)EditorUtilityCompat.IDToObject(instanceId);
			if (go == null)
				return SceneToolsHelpers.JsonError("GameObject not found");

			Undo.RecordObject(go.transform, "MCP Set Transform");
			var t = go.transform;
			if (args.ContainsKey("position"))
			{
				var arr = SceneToolsHelpers.GetFloatArray(args, "position");
				if (arr != null && arr.Length >= 3)
					t.position = new Vector3(arr[0], arr[1], arr[2]);
			}
			if (args.ContainsKey("rotation"))
			{
				var arr = SceneToolsHelpers.GetFloatArray(args, "rotation");
				if (arr != null && arr.Length >= 4)
					t.rotation = new Quaternion(arr[0], arr[1], arr[2], arr[3]);
			}
			if (args.ContainsKey("localScale"))
			{
				var arr = SceneToolsHelpers.GetFloatArray(args, "localScale");
				if (arr != null && arr.Length >= 3)
					t.localScale = new Vector3(arr[0], arr[1], arr[2]);
			}
			return "{\"success\":true}";
		}

		private string SetParent(int instanceId, int parentInstanceId)
		{
			if (instanceId < 0)
				return SceneToolsHelpers.JsonError("instanceId is required");
			var go = (GameObject)EditorUtilityCompat.IDToObject(instanceId);
			if (go == null)
				return SceneToolsHelpers.JsonError("GameObject not found");

			Transform parent = null;
			if (parentInstanceId >= 0)
			{
				var parentGo = (GameObject)EditorUtilityCompat.IDToObject(parentInstanceId);
				if (parentGo != null)
					parent = parentGo.transform;
			}

			Undo.SetTransformParent(go.transform, parent, "MCP Set Parent");
			return "{\"success\":true}";
		}

		// -----------------------------------------------------------------------------
		// manage_component
		// -----------------------------------------------------------------------------
	}

	[MCPTool("manage_component")]
	internal sealed class ManageComponentTool : IToolHandler
	{
		public string ToolName => "manage_component";
		public string Description => "Add, remove, getProperties, or setProperty on components.";

		public string HandleCommand(string argsJson)
		{
			var args = SceneToolsHelpers.ParseArgs(argsJson);
			var action = SceneToolsHelpers.GetString(args, "action", "");

			switch (action)
			{
				case "add":
					return Add(SceneToolsHelpers.GetInt(args, "instanceId", -1), SceneToolsHelpers.GetString(args, "componentType", ""));
				case "remove":
					return Remove(SceneToolsHelpers.GetInt(args, "instanceId", -1), SceneToolsHelpers.GetString(args, "componentType", ""));
				case "getProperties":
					return GetProperties(SceneToolsHelpers.GetInt(args, "instanceId", -1));
					case "setProperty":
					object value;
					args.TryGetValue("value", out value);
					return SetProperty(SceneToolsHelpers.GetInt(args, "instanceId", -1), SceneToolsHelpers.GetString(args, "propertyPath", ""), value);
				default:
					return SceneToolsHelpers.JsonError($"Unknown action: {action}");
			}
		}

		private string Add(int instanceId, string componentType)
		{
			if (instanceId < 0)
				return SceneToolsHelpers.JsonError("instanceId is required");
			if (string.IsNullOrEmpty(componentType))
				return SceneToolsHelpers.JsonError("componentType is required");
			var go = (GameObject)EditorUtilityCompat.IDToObject(instanceId);
			if (go == null)
				return SceneToolsHelpers.JsonError("GameObject not found");

			var type = Type.GetType(componentType) ?? Type.GetType(componentType + ", UnityEngine");
			if (type == null)
				return SceneToolsHelpers.JsonError($"Component type not found: {componentType}");
			var comp = go.AddComponent(type);
			Undo.RegisterCreatedObjectUndo(comp, "MCP Add Component");
			return "{\"success\":true,\"componentInstanceId\":" + comp.GetInstanceID() + "}";
		}

		private string Remove(int instanceId, string componentType)
		{
			if (instanceId < 0)
				return SceneToolsHelpers.JsonError("instanceId is required");
			if (string.IsNullOrEmpty(componentType))
				return SceneToolsHelpers.JsonError("componentType is required");
			var go = (GameObject)EditorUtilityCompat.IDToObject(instanceId);
			if (go == null)
				return SceneToolsHelpers.JsonError("GameObject not found");

			var type = Type.GetType(componentType) ?? Type.GetType(componentType + ", UnityEngine");
			if (type == null)
				return SceneToolsHelpers.JsonError($"Component type not found: {componentType}");
			var comp = go.GetComponent(type);
			if (comp == null)
				return SceneToolsHelpers.JsonError($"Component not found on GameObject");
			Undo.DestroyObjectImmediate(comp);
			return "{\"success\":true}";
		}

		private string GetProperties(int instanceId)
		{
			if (instanceId < 0)
				return SceneToolsHelpers.JsonError("instanceId is required");
			var obj = EditorUtilityCompat.IDToObject(instanceId);
			if (obj == null)
				return SceneToolsHelpers.JsonError("Object not found");

			var so = new SerializedObject(obj);
			var iterator = so.GetIterator();
			var sb = new StringBuilder();
			sb.Append("{\"properties\":[");
			var first = true;
			iterator.Next(true);
			do
			{
				if (first == false) sb.Append(",");
				first = false;
				sb.Append("{\"path\":\"").Append(SceneToolsHelpers.Escape(iterator.propertyPath)).Append("\",\"type\":\"").Append(SceneToolsHelpers.Escape(iterator.type)).Append("\"}");
			}
			while (iterator.Next(false));
			sb.Append("]}");
			return sb.ToString();
		}

		private string SetProperty(int instanceId, string propertyPath, object value)
		{
			if (instanceId < 0)
				return SceneToolsHelpers.JsonError("instanceId is required");
			if (string.IsNullOrEmpty(propertyPath))
				return SceneToolsHelpers.JsonError("propertyPath is required");
			var obj = EditorUtilityCompat.IDToObject(instanceId);
			if (obj == null)
				return SceneToolsHelpers.JsonError("Object not found");

			var so = new SerializedObject(obj);
			var prop = so.FindProperty(propertyPath);
			if (prop == null)
				return SceneToolsHelpers.JsonError($"Property not found: {propertyPath}");

			Undo.RecordObject(obj, "MCP Set Property");
			if (value is float f)
				prop.floatValue = f;
			else if (value is int i)
				prop.intValue = i;
			else if (value is bool b)
				prop.boolValue = b;
			else if (value is string s)
				prop.stringValue = s;
			else if (value is double d)
				prop.floatValue = (float)d;
			else if (value != null)
				prop.stringValue = value.ToString();
			so.ApplyModifiedProperties();
			return "{\"success\":true}";
		}
	}

	// -----------------------------------------------------------------------------
	// Shared helpers
	// -----------------------------------------------------------------------------

	internal static class SceneToolsHelpers
	{
		internal static Dictionary<string, object> ParseArgs(string json)
		{
			var d = new Dictionary<string, object>();
			if (string.IsNullOrEmpty(json))
				return d;
			try
			{
				var obj = JsonUtility.FromJson<SimpleArgs>(json);
				if (obj != null)
				{
					if (obj.action != null) d["action"] = obj.action;
					if (obj.path != null) d["path"] = obj.path;
					if (obj.name != null) d["name"] = obj.name;
					d["instanceId"] = obj.instanceId;
					d["parentInstanceId"] = obj.parentInstanceId;
					if (obj.componentType != null) d["componentType"] = obj.componentType;
					if (obj.propertyPath != null) d["propertyPath"] = obj.propertyPath;
					if (obj.position != null) d["position"] = obj.position;
					if (obj.rotation != null) d["rotation"] = obj.rotation;
					if (obj.localScale != null) d["localScale"] = obj.localScale;
					if (obj.valueNumber != 0) d["value"] = obj.valueNumber;
					else if (obj.valueString != null) d["value"] = obj.valueString;
					else if (obj.valueBool) d["value"] = obj.valueBool;
				}
			}
			catch { }
			return d;
		}

		internal static string GetString(Dictionary<string, object> d, string key, string def)
		{
			if (d.TryGetValue(key, out var v) == false || v == null)
				return def;
			return v.ToString();
		}

		internal static int GetInt(Dictionary<string, object> d, string key, int def)
		{
			if (d.TryGetValue(key, out var v) == false)
				return def;
			if (v is int vi) return vi;
			if (v is long l) return (int)l;
			if (v is float f) return (int)f;
			if (v is double db) return (int)db;
			int.TryParse(v.ToString(), out var parsed);
			return parsed;
		}

		internal static float[] GetFloatArray(Dictionary<string, object> d, string key)
		{
			if (d.TryGetValue(key, out var v) == false || v == null)
				return null;
			if (v is float[] arr)
				return arr;
			return null;
		}

		internal static object GetValue(Dictionary<string, object> d, string key)
		{
			if (d.TryGetValue(key, out var v) == false)
				return null;
			return v;
		}

		internal static string JsonError(string msg) => "{\"success\":false,\"error\":\"" + SceneToolsHelpers.Escape(msg) + "\"}";
		internal static string Escape(string s)
		{
			if (s == null) return string.Empty;
			return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n").Replace("\r", "\\r");
		}
	}

	[Serializable]
	internal class SimpleArgs
	{
		public string action;
		public string path;
		public string name;
		public int instanceId;
		public int parentInstanceId;
		public string componentType;
		public string propertyPath;
		public float[] position;
		public float[] rotation;
		public float[] localScale;
		public double valueNumber;
		public string valueString;
		public bool valueBool;
	}
}

#endif
