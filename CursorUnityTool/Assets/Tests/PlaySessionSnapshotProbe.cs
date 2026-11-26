#if UNITY_EDITOR
using UnityEngine;

namespace UnityCursorToolkit.InternalSmoke
{
	// Editor-only serialized fixture for the native snapshot contract.
	public sealed class PlaySessionSnapshotProbe : MonoBehaviour
	{
		public GameObject assigned;
		public Object unassigned;
		public string excludedString = "UCT_VALUE_MUST_NOT_BE_CAPTURED";
	}
}
#endif
