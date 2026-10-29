import Foundation
import Darwin

/// Commands are intentional shell programs supplied by a paired phone. Output is
/// discarded; only exit/timeout status is returned, so secrets never enter logs.
enum ShellCommandRunner {
    static func run(_ command: String, timeout: TimeInterval = 20, completion: @escaping (Bool, String?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            var actions: posix_spawn_file_actions_t?
            var attributes: posix_spawnattr_t?
            guard posix_spawn_file_actions_init(&actions) == 0 else { completion(false, "Could not prepare the command."); return }
            defer { posix_spawn_file_actions_destroy(&actions) }
            guard posix_spawnattr_init(&attributes) == 0 else { completion(false, "Could not prepare the command."); return }
            defer { posix_spawnattr_destroy(&attributes) }
            for descriptor in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
                guard posix_spawn_file_actions_addopen(&actions, descriptor, "/dev/null", descriptor == STDIN_FILENO ? O_RDONLY : O_WRONLY, 0) == 0 else {
                    completion(false, "Could not redirect command output."); return
                }
            }
            guard posix_spawn_file_actions_addchdir_np(&actions, FileManager.default.homeDirectoryForCurrentUser.path) == 0 else {
                completion(false, "Could not set the command working directory."); return
            }
            // A dedicated process group allows timeout to stop the shell and its
            // foreground child processes, including commands that ignore TERM.
            // The child may inherit only the explicit /dev/null redirections,
            // never receiver sockets, credential-store descriptors, or log files.
            guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)) == 0,
                  posix_spawnattr_setpgroup(&attributes, 0) == 0 else { completion(false, "Could not prepare the command process."); return }
            let argumentStrings = ["/bin/zsh", "-lc", command]
            let environmentStrings = ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" }
            var arguments = argumentStrings.map { strdup($0) } + [nil]
            var environment = environmentStrings.map { strdup($0) } + [nil]
            defer { arguments.forEach { free($0) }; environment.forEach { free($0) } }
            guard arguments.dropLast().allSatisfy({ $0 != nil }), environment.dropLast().allSatisfy({ $0 != nil }) else {
                completion(false, "Could not allocate command arguments."); return
            }
            var pid: pid_t = 0
            let error = posix_spawn(&pid, "/bin/zsh", &actions, &attributes, &arguments, &environment)
            guard error == 0 else { completion(false, "Could not start the command."); return }
            let deadline = ProcessInfo.processInfo.systemUptime + max(0.01, timeout)
            var status: Int32 = 0, timedOut = false
            while true {
                let result = waitpid(pid, &status, WNOHANG)
                if result == pid { break }
                if result == -1 && errno != EINTR { completion(false, "Could not read the command exit status."); return }
                if ProcessInfo.processInfo.systemUptime >= deadline {
                    timedOut = true
                    // KILL provides a definite bound; no following gesture action
                    // starts while the timed-out foreground process is still alive.
                    kill(-pid, SIGKILL)
                    // Also stop the original process if the command changed its
                    // process group. Its PID cannot be reused before waitpid.
                    kill(pid, SIGKILL)
                    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
                    break
                }
                Thread.sleep(forTimeInterval: 0.02)
            }
            if timedOut { completion(false, "Command timed out and was stopped."); return }
            let signal = status & 0x7f
            let code = (status >> 8) & 0xff
            if signal != 0 { completion(false, "Command ended after signal \(signal).") }
            else { completion(code == 0, code == 0 ? "Command completed." : "Command exited with status \(code).") }
        }
    }
}
