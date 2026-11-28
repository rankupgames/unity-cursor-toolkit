using System;

namespace UnityCursorToolkit
{
	/// <summary>Supplies optional project state to the Unity Editor's Game Flow window.</summary>
	public static class GameFlowProjectState
	{
		internal static Func<string> Source { get; private set; }

		/// <summary>Sets the project source on the Editor main thread. Pass null to remove it.
		/// Return cached display text, or null while state is unavailable.
		/// The window calls this source on the Editor main thread while controls are enabled.</summary>
		public static void SetSource(Func<string> readState)
		{
			Source = readState;
		}
	}
}
