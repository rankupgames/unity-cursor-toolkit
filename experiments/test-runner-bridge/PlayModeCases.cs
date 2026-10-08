using System;
using System.Collections;
using NUnit.Framework;
using UnityEngine.TestTools;

namespace BridgeProof.Play
{
	public class Waiting
	{
		[UnityTest] public IEnumerator Heartbeats()
		{
			DateTime finish = DateTime.UtcNow.AddSeconds(4);
			while (DateTime.UtcNow < finish) yield return null;
			Assert.IsTrue(true);
		}
		[UnityTest] public IEnumerator CancelOwned()
		{
			DateTime finish = DateTime.UtcNow.AddSeconds(30);
			while (DateTime.UtcNow < finish) yield return null;
			Assert.Fail("The owned cancellation test should stop before this line.");
		}
	}
}
