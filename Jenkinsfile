@Library('homelab') _

// The registered job owns its source pin, lane, credentials and library revision.
def remotes = scm.userRemoteConfigs
def branches = scm.branches
def revision = params.SOURCE_SHA
if (remotes.size() != 1 || branches.size() != 1 ||
    remotes[0].url != 'https://github.com/rankupgames/unity-cursor-toolkit.git' ||
    !(revision instanceof String) || !(revision ==~ /[0-9a-f]{40}/) ||
    !(branches[0].name in [revision, '${SOURCE_SHA}'])) {
    error('unity_toolkit_ci_source_invalid')
}
def refspec = remotes[0].refspec
def prefix = '+refs/heads/'
def separator = ':refs/remotes/origin/'
if (!(refspec instanceof String) || !refspec.startsWith(prefix) || refspec.indexOf(separator) < 0) {
    error('unity_toolkit_ci_refspec_invalid')
}
def branch = refspec.substring(prefix.length(), refspec.indexOf(separator))
if (!(branch ==~ /[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}/) ||
    refspec != "${prefix}${branch}${separator}${branch}".toString()) {
    error('unity_toolkit_ci_refspec_invalid')
}

homelabPipeline(
    agentLabel: 'homelab-dev3-linux',
    branch: branch,
    sourceRepository: remotes[0].url,
    scmCredentialId: remotes[0].credentialsId,
    sourceRevisionParameter: 'SOURCE_SHA',
    scriptPath: 'Jenkinsfile',
    pipelineRevision: revision,
    timeoutMinutes: 30,
    lanes: [check: [os: 'linux', queueProfile: 'small-web', checkCommand: 'bash ci/jenkins/check.sh']]
)
