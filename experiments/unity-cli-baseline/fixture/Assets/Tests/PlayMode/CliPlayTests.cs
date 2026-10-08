using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

public class CliPlayTests
{
    [UnityTest] public IEnumerator Passing()
    {
        yield return null;
        Assert.That(Application.isPlaying, Is.True);
    }

    [UnityTest] public IEnumerator LongProgress()
    {
        for (var second = 0; second < 30; second++)
        {
            Debug.Log("CLI_PROOF_PROGRESS " + second);
            yield return new WaitForSecondsRealtime(1);
        }
    }
}
