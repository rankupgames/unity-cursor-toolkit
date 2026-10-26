#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

namespace UnityCursorToolkit.Core
{
	// No FilePathAttribute and no Save(): Unity retains only serialized native-memory state across reload.
	internal sealed class StaticSnapshotState : ScriptableSingleton<StaticSnapshotState>
	{
		private void OnEnable() { StaticSnapshotter.InitializeLifecycle(); }
		private void OnDisable() { StaticSnapshotter.DetachHooks(); }

		[SerializeField] internal bool enabled;
		[SerializeField] internal string[] assemblyAllowlist = new string[0];
		[SerializeField] internal int maxFields = 1000;
		[SerializeField] internal int maxScanMilliseconds = 10;
		[SerializeField] internal StaticSnapshotter.Snapshot latestSnapshot;
		[SerializeField] internal StaticSnapshotter.Snapshot previousSnapshot;
		[SerializeField] internal string previousTransition = "";
		[SerializeField] internal StaticSnapshotter.Diff latestDiff;
	}
}
#endif
