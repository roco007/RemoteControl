/// A changed physical lock state becomes authoritative before the next remote key.
public struct CapsLockState {
    private var effective: Bool
    private var lastPhysical: Bool
    public init(initial: Bool, physical: Bool) { effective = initial; lastPhysical = physical }
    public mutating func resolve(physical: Bool, remoteToggle: Bool) -> Bool {
        if physical != lastPhysical { effective = physical; lastPhysical = physical }
        if remoteToggle { effective.toggle() }
        return effective
    }
}
