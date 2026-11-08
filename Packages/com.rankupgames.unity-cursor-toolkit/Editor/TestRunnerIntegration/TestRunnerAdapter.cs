#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;

namespace UnityCursorToolkit.TestRunnerIntegration
{
	[InitializeOnLoad]
	internal static partial class TestRunnerAdapter
	{
		private const int MaxTests = 10000, MaxStateBytes = 1024 * 1024;
		private static TestRunnerApi _api;
		private static Callbacks _callbacks;
		private static State _job;
		private static Action<string> _progress;
		private static string _stateKey, _project, _version, _home, _editorDirectory;
		private static int _pid;
		private static bool _initialized, _quitting, _foreignActive;
		private static double _lastHeartbeat;
		private static MethodInfo _cancel, _isRunning, _getRunner;
		private static PropertyInfo _holder;
		private static object _observedHolder;
		private static bool _seenRegisteredActive, _probeFailed, _probeSupported;

		static TestRunnerAdapter()
		{
#if !UNITY_7000_0_OR_NEWER
			Initialize();
#endif
		}

#if UNITY_7000_0_OR_NEWER
		[Unity.Scripting.LifecycleManagement.OnCodeInitializing]
#endif
		private static void Initialize()
		{
			if (_initialized || _quitting) return;
#if UNITY_2020_2_OR_NEWER
			if (AssetDatabase.IsAssetImportWorkerProcess()) return;
#endif
			_seenRegisteredActive = false; _observedHolder = null; _probeFailed = false;
			_home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
			_editorDirectory = Path.GetDirectoryName(EditorApplication.applicationPath);
			_project = Path.GetFullPath(Directory.GetParent(Application.dataPath).FullName);
			_version = Application.unityVersion;
			_pid = Process.GetCurrentProcess().Id;
			using (var sha = SHA256.Create())
				_stateKey = "UnityCursorToolkit.Tests." + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(_project))).Replace("-", "");
			_cancel = typeof(TestRunnerApi).GetMethod("CancelTestRun", BindingFlags.Static | BindingFlags.Public,
				null, new[] { typeof(string) }, null);
			if (_cancel != null && _cancel.ReturnType != typeof(bool)) _cancel = null;
			_probeSupported = BindNativeProbe();
			string saved = SessionState.GetString(_stateKey, "");
			if (!string.IsNullOrEmpty(saved) && Encoding.UTF8.GetByteCount(saved) <= MaxStateBytes)
			{
				try { _job = JsonUtility.FromJson<State>(saved); }
				catch (Exception) { _job = null; }
				if (_job != null && (_job.projectPath != _project || _job.editorPid != _pid)) _job = null;
			}
			_foreignActive = SessionState.GetBool(_stateKey + ".foreign", false);
			_api = ScriptableObject.CreateInstance<TestRunnerApi>();
			_callbacks = new Callbacks();
			_api.RegisterCallbacks(_callbacks);
			EditorApplication.update += Update;
			EditorApplication.quitting += Quit;
#if !UNITY_7000_0_OR_NEWER
			AssemblyReloadEvents.beforeAssemblyReload += Unload;
#endif
			_initialized = true;
		}

		private static void Quit()
		{
			_quitting = true;
			Detach();
		}

#if UNITY_7000_0_OR_NEWER
		[Unity.Scripting.LifecycleManagement.OnCodeUnloading]
#endif
		private static void Unload()
		{
			// At shutdown the native Editor can already be gone.
			if (_quitting || !_initialized) return;
			if (IsActive() && EditorApplication.isCompiling)
			{
				SetError("test_job_interrupted", "Source compilation interrupted the owned test job.", "error");
				RequestNativeCancel();
			}
			Save();
			Detach();
		}

		private static void Detach()
		{
			if (!_initialized) return;
			EditorApplication.update -= Update;
			EditorApplication.quitting -= Quit;
#if !UNITY_7000_0_OR_NEWER
			AssemblyReloadEvents.beforeAssemblyReload -= Unload;
#endif
			if (_api != null)
			{
				_api.UnregisterCallbacks(_callbacks);
				UnityEngine.Object.DestroyImmediate(_api);
			}
			_api = null; _callbacks = null; _initialized = false; _progress = null;
			_observedHolder = null; _seenRegisteredActive = false;
			_holder = null; _getRunner = null; _isRunning = null; _cancel = null; _probeSupported = false;
		}

		// A null request binds the production facade's sink after handler recreation.
		// Client requests are checked by the facade before this internal entrypoint.
		internal static string Handle(string json, Action<string> progress)
		{
			if (progress != null) _progress = progress;
			if (json == null) return "";
			Request request = null;
			try
			{
				Initialize();
				if (_quitting || !_initialized) return Refuse(null, "test_runner_unavailable", "The Editor test API is unavailable in this process.");
				if (Encoding.UTF8.GetByteCount(json) > 65536) return Refuse(null, "invalid_test_request", "The request exceeds 64KiB.");
				request = JsonUtility.FromJson<Request>(json);
				if (request?.action == "capabilities")
					return JsonUtility.ToJson(new Capabilities { editorVersion = _version, projectPath = _project, editorPid = _pid, supportsCancellation = _cancel != null && _probeSupported && !_probeFailed });
				if (request == null || (request.mode != "EditMode" && request.mode != "PlayMode")
					|| string.IsNullOrEmpty(request.ownerToken) || request.ownerToken.Length > 256
					|| string.IsNullOrEmpty(request.projectPath) || string.IsNullOrEmpty(request.runId) || request.runId.Length > 128)
					return Refuse(request, "invalid_test_request", "Concrete mode, runId, projectPath and job ownership are required.");
				var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
				if (!string.Equals(Path.GetFullPath(request.projectPath).TrimEnd(Path.DirectorySeparatorChar), _project.TrimEnd(Path.DirectorySeparatorChar), comparison)
					|| (request.editorPid != 0 && request.editorPid != _pid))
					return Refuse(request, "test_job_owner_mismatch", "The request targets another project or Editor.");
				if (request.action == "status" || request.action == "cancel")
				{
					if (_job == null || request.runId != _job.snapshot.runId)
						return Refuse(request, "test_job_not_found", "The owned test job was not found.");
					if (request.ownerToken != _job.ownerToken || request.mode != _job.snapshot.mode)
						return Refuse(request, "test_job_owner_mismatch", "The request belongs to another connection generation or mode.");
					if (request.action == "cancel")
					{
						if (_job.snapshot.status == "discovering")
						{
							_job.cancelCode = "cancelled";
							SetError("cancelled", "The owned discovery was cancelled before execution.", "cancelled");
							Publish("finished", "");
							return JsonUtility.ToJson(_job.snapshot);
						}
						if (!_job.nativePending) return JsonUtility.ToJson(_job.snapshot);
						// Cancel=false may mean already cancelling. Only exact holder absence confirms stop.
						RequestNativeCancel();
						_job.cancelCode = "cancelled";
						Publish("cancel_requested", "");
					}
					return JsonUtility.ToJson(_job.snapshot);
				}
				if (request.action != "list" && request.action != "run")
					return Refuse(request, "invalid_test_request", "action must be list, run, status or cancel.");
				if (IsActive() || _foreignActive) return Refuse(request, "test_job_busy", "An owned or observed external test job is active.");
				if (_job != null && request.runId == _job.snapshot.runId)
					return Refuse(request, "test_job_owner_mismatch", "A terminal runId cannot be reused for another operation.");
				if (request.action == "run" && (_cancel == null || !_probeSupported || _probeFailed))
					return Refuse(request, "test_cancel_unavailable", "This framework has no verified GUID-scoped cancellation and stop observation contract; execution is refused.");
				if (request.timeoutMs < 0 || request.timeoutMs > 600000)
					return Refuse(request, "invalid_test_request", "timeoutMs must be positive and at most 600000.");
				_seenRegisteredActive = false; _observedHolder = null;
				_job = new State
				{
					projectPath = _project, editorPid = _pid, ownerToken = request.ownerToken,
					deadline = DateTime.UtcNow.AddSeconds(30).Ticks,
					request = request,
					snapshot = NewSnapshot(request.mode, "discovering", request.runId),
				};
				Publish("discovering", "");
				string runId = _job.snapshot.runId;
				_api.RetrieveTestList(request.mode == "EditMode" ? TestMode.EditMode : TestMode.PlayMode,
					tree => Discovered(runId, tree));
				return JsonUtility.ToJson(_job.snapshot);
			}
			catch (Exception)
			{
				return Refuse(request, "test_runner_failed", "The Editor test API could not handle this request.");
			}
		}

		private static void Discovered(string runId, ITestAdaptor tree)
		{
			if (_quitting || _job == null || _job.snapshot.runId != runId || _job.snapshot.status != "discovering") return;
			try
			{
				var all = Leaves(tree).Select(Metadata).ToArray();
				Request request = _job.request;
				Filters filters = request.filter ?? new Filters();
				bool needsType = !string.IsNullOrEmpty(filters.assembly) || !string.IsNullOrEmpty(filters.@namespace) || !string.IsNullOrEmpty(filters.@class);
				if (needsType && all.Any(test => test.type == null))
					throw new JobError("test_metadata_unavailable", "Exact filtering requires fixture type metadata that is missing.");
				var selected = all.Where(test => Matches(test, request)).ToArray();
				if (selected.Length == 0) throw new JobError("test_selection_empty", "No tests match all literal filters.");
				// A fullname filter cannot distinguish duplicate cases in the same assembly.
				if (selected.Any(test => all.Count(other => other.test.FullName == test.test.FullName && other.assembly == test.assembly) != 1))
					throw new JobError("test_selection_ambiguous", "Duplicate full names in one assembly cannot be selected exactly.");
				var names = new HashSet<string>(selected.Select(test => test.test.FullName), StringComparer.Ordinal);
				var assemblies = new HashSet<string>(selected.Select(test => test.assembly), StringComparer.Ordinal);
				var exact = new HashSet<Leaf>(selected);
				if (names.Count != selected.Length || all.Any(test => !exact.Contains(test) && names.Contains(test.test.FullName) && assemblies.Contains(test.assembly)))
					throw new JobError("test_selection_ambiguous", "The framework fullname and assembly filters would execute an unselected or duplicate test.");
				if (selected.Any(test => string.IsNullOrEmpty(test.assembly)))
					throw new JobError("test_metadata_unavailable", "Assembly metadata is required for an exact execution scope.");
				_job.selectedNames = selected.Select(test => test.test.FullName).ToArray();
				_job.snapshot.selection = _job.selectedNames.Select(Sanitize).ToArray();
				_job.snapshot.tests = selected.Select((test, index) => new Test
				{
					id = index.ToString(System.Globalization.CultureInfo.InvariantCulture), fullName = Sanitize(test.test.FullName), status = "not_run", message = "", stackTrace = ""
				}).ToList();
				_job.assemblyNames = selected.Select(test => test.assembly).Distinct().ToArray();
				_job.testAssemblies = selected.Select(test => test.assembly).ToArray();
				_job.testIds = selected.Select(test => test.test.Id).ToArray();
				Count();
				if (_job.request.action == "list")
				{
					_job.snapshot.status = "listed"; Publish("finished", ""); return;
				}
				if (_foreignActive) throw new JobError("test_job_busy", "An external test job started during discovery.");
				_job.snapshot.status = "running";
				_job.deadline = DateTime.UtcNow.AddMilliseconds(request.timeoutMs == 0 ? 600000 : request.timeoutMs).Ticks;
				if (!Save()) return;
				var filter = new Filter
				{
					testMode = request.mode == "EditMode" ? TestMode.EditMode : TestMode.PlayMode,
					testNames = _job.selectedNames.Distinct().ToArray(),
					assemblyNames = _job.assemblyNames
				};
				_job.nativePending = true;
				_job.frameworkGuid = _api.Execute(new ExecutionSettings(filter));
				if (string.IsNullOrEmpty(_job.frameworkGuid)) throw new JobError("test_runner_failed", "Execute did not return an owned job GUID.");
				Publish("running", "");
			}
			catch (JobError error) { SetError(error.code, error.Message, "error"); Publish(_job.nativePending ? "cleanup_pending" : "finished", ""); }
			catch (Exception) { SetError("test_runner_failed", "Test discovery or execution failed.", "error"); Publish("finished", ""); }
		}

		private static IEnumerable<ITestAdaptor> Leaves(ITestAdaptor root)
		{
			var pending = new Stack<ITestAdaptor>(); pending.Push(root);
			int nodes = 0, tests = 0;
			while (pending.Count != 0)
			{
				ITestAdaptor node = pending.Pop();
				if (node == null || ++nodes > MaxTests * 10) throw new JobError("test_selection_too_large", "The test tree exceeds the bounded discovery size.");
				if (!node.IsSuite)
				{
					if (++tests > MaxTests) throw new JobError("test_selection_too_large", "More than 10000 leaf tests were discovered.");
					yield return node;
				}
				else if (node.Children != null)
					foreach (var child in node.Children) pending.Push(child);
			}
		}

		private sealed class Leaf
		{
			internal ITestAdaptor test;
			internal Type type;
			internal string assembly;
			internal HashSet<string> categories = new HashSet<string>(StringComparer.Ordinal);
		}
		private static Leaf Metadata(ITestAdaptor test)
		{
			var leaf = new Leaf { test = test };
			ITestAdaptor ancestor = test;
			for (int depth = 0; ancestor != null && depth < 64; depth++, ancestor = ancestor.Parent)
			{
				if (ancestor.Categories != null) foreach (string category in ancestor.Categories) leaf.categories.Add(category);
				// Reflect only the known framework TypeInfo metadata; no NUnit compile dependency.
				object info = typeof(ITestAdaptor).GetProperty("TypeInfo")?.GetValue(ancestor, null);
				Type type = info?.GetType().GetProperty("Type")?.GetValue(info, null) as Type;
				if (leaf.type == null && type != null) { leaf.type = type; leaf.assembly = type.Assembly.GetName().Name; }
			}
			return leaf;
		}
		private static bool Matches(Leaf test, Request request)
		{
			Filters filters = request.filter ?? new Filters();
			string ns = test.type?.Namespace ?? "";
			return (string.IsNullOrEmpty(filters.assembly) || test.assembly == filters.assembly)
				&& (string.IsNullOrEmpty(filters.@namespace) || ns == filters.@namespace || ns.StartsWith(filters.@namespace + ".", StringComparison.Ordinal))
				&& (string.IsNullOrEmpty(filters.@class) || test.type?.FullName == filters.@class)
				&& (string.IsNullOrEmpty(filters.test) || test.test.FullName == filters.test)
				&& (string.IsNullOrEmpty(filters.category) || test.categories.Contains(filters.category));
		}

		// Private framework contracts are restricted to exact source-reviewed versions.
		private static bool BindNativeProbe()
		{
			try
			{
				Type packageType = typeof(EditorApplication).Assembly.GetType("UnityEditor.PackageManager.PackageInfo");
				MethodInfo find = packageType?.GetMethod("FindForAssembly", BindingFlags.Public | BindingFlags.Static,
					null, new[] { typeof(Assembly) }, null);
				object package = find?.Invoke(null, new object[] { typeof(TestRunnerApi).Assembly });
				string name = package == null ? null : (string)packageType.GetProperty("name")?.GetValue(package, null);
				string version = package == null ? null : (string)packageType.GetProperty("version")?.GetValue(package, null);
				if (name != "com.unity.test-framework" || (version != "1.6.0" && version != "1.8.0" && version != "1.9.0")) return false;
				Type api = typeof(TestRunnerApi);
				_holder = api.GetProperty("m_testJobDataHolder", BindingFlags.NonPublic | BindingFlags.Static);
				Type holderType = api.Assembly.GetType("UnityEditor.TestTools.TestRunner.TestRun.ITestJobDataHolder");
				Type runnerType = api.Assembly.GetType("UnityEditor.TestTools.TestRunner.TestRun.ITestJobRunner");
				if (_holder?.PropertyType != holderType || holderType == null || runnerType == null
					|| _holder.GetGetMethod(true) == null || !_holder.GetGetMethod(true).IsStatic
					|| _holder.GetGetMethod(true).GetParameters().Length != 0 || _holder.GetIndexParameters().Length != 0) return false;
				_getRunner = holderType.GetMethod("GetRunner", new[] { typeof(string) });
				_isRunning = api.GetMethod("IsRunning", BindingFlags.NonPublic | BindingFlags.Static,
					null, new[] { typeof(string) }, null);
				return _getRunner?.ReturnType == runnerType && !_getRunner.IsStatic && _isRunning?.ReturnType == typeof(bool);
			}
			catch (Exception) { return false; }
		}

		private static void ObserveNativeStop()
		{
			if (!_job.nativePending || !_probeSupported || _probeFailed || string.IsNullOrEmpty(_job.frameworkGuid)) return;
			try
			{
				object holder = _holder.GetValue(null, null);
				if (holder == null) throw new InvalidOperationException();
				if (_seenRegisteredActive && !ReferenceEquals(holder, _observedHolder)) throw new InvalidOperationException();
				object runner = _getRunner.Invoke(holder, new object[] { _job.frameworkGuid });
				bool active = (bool)_isRunning.Invoke(null, new object[] { _job.frameworkGuid });
				if (runner != null && active)
				{
					_observedHolder = holder; _seenRegisteredActive = true;
					return;
				}
				// False alone precedes StopRun. Reload/replacement cannot inherit old positive proof.
				// This later Editor update runs outside callbacks, after synchronous StopRun returned.
				if (runner == null && !active && _seenRegisteredActive && ReferenceEquals(holder, _observedHolder))
				{
					_job.nativePending = false; _job.cancelPending = false;
					FinishStoppedJob();
				}
			}
			catch (Exception)
			{
				_probeFailed = true;
				SetError("test_stop_unconfirmed", "The verified framework stop observer failed after execution started.", "error");
				Save();
			}
		}

		private static void FinishStoppedJob()
		{
			if (_job.resultOmitted || _job.callbackConflict)
			{
				_job.snapshot.tests.Clear(); _job.snapshot.selection = new string[0];
				_job.selectedNames = new string[0]; _job.testIds = new string[0];
				_job.testAssemblies = new string[0]; _job.assemblyNames = new string[0];
			}
			Count();
			if (!string.IsNullOrEmpty(_job.pendingStatus))
				_job.snapshot.status = _job.pendingStatus;
			else if (!string.IsNullOrEmpty(_job.cancelCode))
				SetError(_job.cancelCode, _job.cancelCode == "cancelled" ? "The owned test job was cancelled." : "The owned test job exceeded its deadline.",
					_job.cancelCode == "cancelled" ? "cancelled" : "timed_out");
			else if (!HasError() && (!_job.completionReceived || _job.snapshot.summary.notRun > 0))
				SetError("test_results_incomplete", "The native run did not return every selected test result.", "error");
			else if (!HasError())
			{
				if (_job.snapshot.summary.failed > 0)
					SetError("test_runner_failed", "One or more selected tests failed.", "failed");
				else { _job.snapshot.status = "completed"; _job.snapshot.success = true; }
			}
			Publish("finished", "");
		}

		private static bool HasError() => !string.IsNullOrEmpty(_job?.snapshot?.error?.code);
		private static bool IsActive() => _job != null && (_job.nativePending || _job.snapshot.status == "discovering");
		private static bool RequestNativeCancel()
		{
			if (_cancel == null || _job == null || !_job.nativePending || string.IsNullOrEmpty(_job.frameworkGuid)) return false;
			try { return (bool)_cancel.Invoke(null, new object[] { _job.frameworkGuid }); }
			catch (Exception) { return false; }
		}
		private static void Update()
		{
			if (_quitting || !IsActive()) return;
			ObserveNativeStop();
			if (!IsActive()) return;
			if (_job.nativePending && _job.cancelPending)
			{
				_job.cancelPending = false;
				RequestNativeCancel();
			}
			if (DateTime.UtcNow.Ticks > _job.deadline && string.IsNullOrEmpty(_job.cancelCode))
			{
				_job.cancelCode = "test_job_timed_out";
				SetError("test_job_timed_out", "The owned test job exceeded its deadline.", "timed_out");
				RequestNativeCancel();
				Publish(_job.nativePending ? "cancel_requested" : "finished", "");
			}
			if (_job.nativePending && EditorApplication.timeSinceStartup - _lastHeartbeat >= 1)
			{
				_lastHeartbeat = EditorApplication.timeSinceStartup;
				Publish("heartbeat", "");
			}
		}
		private static void SetError(string code, string message, string status)
		{
			if (_job == null) return;
			_job.snapshot.success = false;
			_job.snapshot.status = _job.nativePending ? "running" : status;
			if (_job.nativePending) _job.pendingStatus = status;
			_job.snapshot.error = new Error { code = code, message = Sanitize(message), recovery = "Inspect the owned job and select a supported explicit backend." };
		}

		private static bool Save()
		{
			if (_job == null || _quitting) return false;
			_job.snapshot.workStopped = !_job.nativePending && _job.snapshot.status != "discovering";
			string json = JsonUtility.ToJson(_job);
			if (Encoding.UTF8.GetByteCount(json) > MaxStateBytes - 4096)
			{
				// Never emit a successful partial result or truncate messages/stacks.
				SetError("result_too_large", "The complete test result exceeds the 1MiB state bound.", "error");
				_job.cancelPending = true;
				_job.resultOmitted = true;
				if (_job.nativePending) return false;
				_job.snapshot.tests.Clear();
				_job.snapshot.selection = new string[0];
				Count();
				json = JsonUtility.ToJson(_job);
				if (Encoding.UTF8.GetByteCount(json) > MaxStateBytes)
				{
					// This branch can only precede Execute if the initial selection is too large.
					_job.selectedNames = new string[0];
					_job.testAssemblies = new string[0]; _job.assemblyNames = new string[0]; _job.testIds = new string[0];
					Count(); json = JsonUtility.ToJson(_job);
					if (Encoding.UTF8.GetByteCount(json) > MaxStateBytes) return false;
				}
				SessionState.SetString(_stateKey, json);
				return false;
			}
			SessionState.SetString(_stateKey, json);
			return true;
		}
		private static void Publish(string phase, string currentTest)
		{
			if (_job == null || _quitting) return;
			_job.sequence++;
			Save();
			var summary = _job.snapshot.summary;
			_progress?.Invoke(JsonUtility.ToJson(new Progress
			{
				runId = _job.snapshot.runId, phase = phase, sequence = _job.sequence,
				completed = summary.passed + summary.failed + summary.skipped + summary.inconclusive,
				total = summary.total, currentTest = Sanitize(currentTest), editorVersion = _version
			}));
		}
		private static void Count()
		{
			var summary = new Summary { total = _job.snapshot.selection.Length };
			foreach (Test test in _job.snapshot.tests)
			{
				switch (test.status)
				{
					case "passed": summary.passed++; break;
					case "failed": summary.failed++; break;
					case "skipped": summary.skipped++; break;
					case "inconclusive": summary.inconclusive++; break;
					default: summary.notRun++; break;
				}
				summary.durationMs += test.durationMs;
			}
			_job.snapshot.summary = summary;
		}
		private static Snapshot NewSnapshot(string mode, string status, string runId = null) => new Snapshot
		{
			runId = runId ?? Guid.NewGuid().ToString("N"), status = status, mode = mode, editorVersion = _version, editorPid = _pid
		};
		private static string Refuse(Request request, string code, string message)
		{
			Snapshot result = NewSnapshot(request?.mode == "EditMode" || request?.mode == "PlayMode" ? request.mode : null, "error");
			if (!string.IsNullOrEmpty(request?.runId)) result.runId = request.runId;
			result.success = false;
			result.workStopped = request?.action != "status" && request?.action != "cancel";
			result.error = new Error { code = code, message = message, recovery = "Check the project, connection ownership, selection and explicit backend." };
			return JsonUtility.ToJson(result);
		}

		private sealed class Callbacks : ICallbacks, IErrorCallbacks
		{
			public void RunStarted(ITestAdaptor root)
			{
				if (_quitting) return;
				if (_job == null || !_job.nativePending || _job.started)
				{
					_foreignActive = true; SessionState.SetBool(_stateKey + ".foreign", true);
					if (_job != null && _job.nativePending && _job.started)
					{
						_job.callbackConflict = true; _job.cancelPending = true;
						SetError("test_job_conflict", "A second native run started during the owned job; completion cannot be attributed safely.", "error"); Save();
					}
					return;
				}
				_job.started = true; Publish("started", "");
			}
			public void TestStarted(ITestAdaptor test)
			{
				if (Find(test) >= 0) Publish("test_started", test.FullName);
			}
			public void TestFinished(ITestResultAdaptor result)
			{
				int index = Find(result.Test);
				if (index < 0 || result.Test.IsSuite) return;
				Apply(index, result); Count(); Publish("test_finished", result.FullName);
			}
			public void RunFinished(ITestResultAdaptor result)
			{
				if (_quitting) return;
				if (_foreignActive && (_job == null || !_job.callbackConflict)) { _foreignActive = false; SessionState.SetBool(_stateKey + ".foreign", false); }
				if (_job == null || !_job.nativePending || !_job.started) return;
				var matched = new HashSet<int>();
				bool unexpected = false;
				var pending = new Stack<ITestResultAdaptor>(); pending.Push(result);
				while (pending.Count != 0)
				{
					var node = pending.Pop();
					if (node.Test.IsSuite)
					{
						if (node.Children != null) foreach (var child in node.Children) pending.Push(child);
						continue;
					}
					int index = Find(node.Test);
					if (index >= 0) { Apply(index, node); matched.Add(index); }
					else unexpected = true;
				}
				if (_job.callbackConflict || unexpected || matched.Count != _job.selectedNames.Length) return;
				_job.completionReceived = true;
				// Callback completion precedes teardown; the update observer releases the owned job.
				Save();
			}
			public void OnError(string message)
			{
				if (_quitting || _job == null || !_job.nativePending) return;
				SetError("test_runner_failed", message, "error"); _job.cancelPending = true; Save();
			}
		}
		private static int Find(ITestAdaptor test)
		{
			if (_quitting || _job == null || !_job.nativePending || test == null || test.IsSuite) return -1;
			Leaf metadata = null;
			for (int i = 0; i < _job.selectedNames.Length; i++)
			{
				if (_job.selectedNames[i] != test.FullName) continue;
				if (_job.testIds[i] == test.Id) return i;
				if (metadata == null) metadata = Metadata(test);
				if (metadata.assembly == _job.testAssemblies[i]) return i;
			}
			return -1;
		}
		private static void Apply(int index, ITestResultAdaptor result)
		{
			if (_job.resultOmitted) return;
			string native = result.ResultState ?? "";
			string status = native.StartsWith("Passed", StringComparison.Ordinal) ? "passed"
				: native.StartsWith("Skipped", StringComparison.Ordinal) ? "skipped"
				: native.StartsWith("Inconclusive", StringComparison.Ordinal) ? "inconclusive"
				: native.StartsWith("Failed", StringComparison.Ordinal) ? "failed" : "not_run";
			if (native.IndexOf("Cancel", StringComparison.OrdinalIgnoreCase) >= 0)
			{
				status = "not_run";
				if (string.IsNullOrEmpty(_job.cancelCode)) _job.cancelCode = "cancelled";
			}
			double duration = result.Duration * 1000;
			if (double.IsNaN(duration) || double.IsInfinity(duration) || duration < 0)
			{
				SetError("test_result_invalid", "A native test duration is invalid.", "error"); duration = 0;
			}
			Test previous = _job.snapshot.tests[index];
			_job.snapshot.tests[index] = new Test
			{
				id = previous.id, fullName = previous.fullName, status = status, durationMs = duration,
				message = Sanitize(result.Message ?? ""), stackTrace = Sanitize(result.StackTrace ?? "")
			};
			if (Encoding.UTF8.GetByteCount(JsonUtility.ToJson(_job)) > MaxStateBytes - 4096)
			{
				_job.snapshot.tests[index] = previous;
				_job.resultOmitted = true;
				SetError("result_too_large", "The complete test result exceeds the 1MiB state bound.", "error");
				_job.cancelPending = true;
			}
		}

		private static string Sanitize(string value)
		{
			if (string.IsNullOrEmpty(value)) return value ?? "";
			foreach (var item in new[] { new[] { _project, "<project>" }, new[] { _home, "<home>" }, new[] { _editorDirectory, "<editor>" } })
				if (!string.IsNullOrEmpty(item[0]))
					foreach (string form in new[] { item[0], item[0].Replace('\\', '/') }) value = value.Replace(form, item[1]);
			if (!string.IsNullOrEmpty(_job?.ownerToken)) value = value.Replace(_job.ownerToken, "<ownership-token>");
			value = Regex.Replace(value, @"(?i)(?:[a-z]:[\\/]|/(?:Users|home|tmp|private)/)[^\s""<>]*", "<path>");
			value = Regex.Replace(value, @"(?i)\b(?:bearer\s+\S+|[a-f0-9]{32,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b", "<token>");
			return value;
		}

		private sealed class JobError : Exception
		{
			internal readonly string code;
			internal JobError(string code, string message) : base(message) { this.code = code; }
		}
		[Serializable] private sealed class Capabilities
		{
			public bool success = true, available = true, supportsCancellation;
			public string backend = "bridge", editorVersion, projectPath;
			public int editorPid;
			public string[] modes = new[] { "EditMode", "PlayMode" };
		}
		[Serializable] private sealed class Request
		{
			public string action, mode, runId, projectPath, ownerToken;
			public Filters filter;
			public int editorPid, timeoutMs;
		}
		[Serializable] private sealed class Filters { public string assembly, @namespace, @class, test, category; }
		[Serializable] private sealed class State
		{
			public string projectPath, ownerToken, frameworkGuid, cancelCode, pendingStatus;
			public int editorPid;
			public long deadline, sequence;
			public bool nativePending, started, resultOmitted, cancelPending, callbackConflict, completionReceived;
			public Request request;
			public Snapshot snapshot;
			public string[] selectedNames = new string[0], assemblyNames = new string[0], testAssemblies = new string[0], testIds = new string[0];
		}
		[Serializable] private sealed class Snapshot
		{
			public bool success = true, workStopped = true;
			public string backend = "bridge", runId, status, editorVersion, mode;
			public int editorPid;
			public string[] selection = new string[0];
			public List<Test> tests = new List<Test>();
			public Summary summary = new Summary();
			public Error error;
		}
		[Serializable] private sealed class Test
		{
			public string id, fullName, status, message, stackTrace;
			public double durationMs;
		}
		[Serializable] private sealed class Summary
		{
			public int total, passed, failed, skipped, inconclusive, notRun;
			public double durationMs;
		}
		[Serializable] private sealed class Error { public string code, message, recovery; }
		[Serializable] private sealed class Progress
		{
			public string runId, phase, currentTest, editorVersion, backend = "bridge";
			public long sequence;
			public int completed, total;
		}
	}
}
#endif
