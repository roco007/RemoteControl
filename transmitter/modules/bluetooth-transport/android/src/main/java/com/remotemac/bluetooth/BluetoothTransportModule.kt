package com.remotemac.bluetooth

import android.Manifest
import android.app.Activity
import android.app.Application
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.lang.ref.WeakReference
import java.util.ArrayDeque
import java.util.UUID

/** One foreground GATT session. All state, including callback cleanup, belongs to the main looper. */
class BluetoothTransportModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var receiverContext: Context? = null
  private var lifecycleApplication: Application? = null
  private var hostActivity: WeakReference<Activity>? = null
  private var foreground = true
  private var destroyed = false
  private var operationGeneration = 0
  private var connectionGeneration = 0
  private var scanGeneration = 0
  private var scannerCallback: ScanCallback? = null
  private var scanTimer: Runnable? = null
  private val devices = linkedMapOf<String, Map<String, Any>>()
  private var gatt: BluetoothGatt? = null
  private var connectPromise: Promise? = null
  private var connectTimer: Runnable? = null
  private var serviceUUID: UUID? = null
  private var writeUUID: UUID? = null
  private var notifyUUID: UUID? = null
  private var writeCharacteristic: BluetoothGattCharacteristic? = null
  private var notifyCharacteristic: BluetoothGattCharacteristic? = null
  private var awaitingBond = false
  private var subscriptionStarted = false
  private var ready = false
  private var mtu = 23
  private var incoming = ByteArray(0)
  private var assemblyTimer: Runnable? = null
  private val writes = ArrayDeque<PendingWrite>()
  private var queuedBytes = 0
  private var writeInFlight = false
  private var currentChunkLength = 0
  private var writeTimer: Runnable? = null

  private data class PendingWrite(val bytes: ByteArray, val promise: Promise, val queuedAt: Long, var offset: Int = 0)

  override fun definition() = ModuleDefinition {
    Name("BluetoothTransport")
    Events("onDevices", "onData", "onDisconnected", "onError", "onState", "onAppState")

    OnCreate {
      main.post {
        if (!destroyed) appContext.reactContext?.applicationContext?.let(::registerLifecycle)
      }
    }
    OnStartObserving("onAppState") {
      main.post {
        if (!destroyed) {
          // Listener attachment happens after React has initialized. Observe even
          // in Wi-Fi-only use if OnCreate ran before its context was available.
          appContext.reactContext?.applicationContext?.let(::registerLifecycle)
          sendEvent("onAppState", mapOf("active" to foreground))
        }
      }
    }

    AsyncFunction("startScan") { uuid: String, promise: Promise ->
      val service = parseUUID(uuid, promise) ?: return@AsyncFunction
      val operation = ++operationGeneration
      withPermissions(promise, operation) { startScan(service, promise) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopScan") {
      operationGeneration += 1
      stopScan()
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("connect") { id: String, service: String, write: String, notify: String, promise: Promise ->
      val serviceID = parseUUID(service, promise) ?: return@AsyncFunction
      val writeID = parseUUID(write, promise) ?: return@AsyncFunction
      val notifyID = parseUUID(notify, promise) ?: return@AsyncFunction
      val operation = ++operationGeneration
      // Close and invalidate the previous GATT before requesting or opening another one.
      stopScan()
      closeConnection("Bluetooth connection replaced.", false)
      withPermissions(promise, operation) { connect(id, serviceID, writeID, notifyID, promise) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("send") { message: String, promise: Promise -> send(message, promise) }.runOnQueue(Queues.MAIN)
    AsyncFunction("disconnect") {
      operationGeneration += 1
      stopScan()
      closeConnection("Bluetooth disconnected.", false)
    }.runOnQueue(Queues.MAIN)
    OnActivityEntersForeground {
      main.post {
        if (!destroyed) {
          appContext.reactContext?.applicationContext?.let(::registerLifecycle)
          appContext.currentActivity?.let { hostActivity = WeakReference(it) }
          foreground = true
          sendEvent("onAppState", mapOf("active" to true))
          publishState()
        }
      }
    }
    OnDestroy {
      main.post {
        destroyed = true
        operationGeneration += 1
        stopScan()
        closeConnection("Bluetooth module stopped.", false)
        receiverContext?.let { try { it.unregisterReceiver(receiver) } catch (_: Exception) { } }
        receiverContext = null
        lifecycleApplication?.unregisterActivityLifecycleCallbacks(lifecycle)
        lifecycleApplication = null
        hostActivity = null
      }
    }
  }

  private fun parseUUID(value: String, promise: Promise): UUID? = try { UUID.fromString(value) }
    catch (_: IllegalArgumentException) { reject(promise, "Invalid Bluetooth service or characteristic UUID."); null }

  private fun adapter(): BluetoothAdapter? {
    val context = appContext.reactContext?.applicationContext ?: return null
    return (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
  }

  private fun hasPermissions(context: Context): Boolean {
    val required = if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
      else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    return required.all { context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
  }

  private fun withPermissions(promise: Promise, operation: Int, action: () -> Unit) {
    if (destroyed || !foreground) { reject(promise, "Keep Remote Mac open to use Bluetooth."); return }
    val context = appContext.reactContext?.applicationContext ?: run { reject(promise, "Android context is unavailable."); return }
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE) || adapter() == null) {
      state("unsupported"); reject(promise, "Bluetooth Low Energy is unavailable on this device."); return
    }
    registerReceiver(context)
    registerLifecycle(context)
    fun granted() {
      if (operation != operationGeneration || destroyed || !foreground) { reject(promise, "Bluetooth operation canceled."); return }
      try {
        if (adapter()?.isEnabled != true) { state("poweredOff"); reject(promise, "Turn on Bluetooth in Android Settings."); return }
        state("poweredOn")
        action()
      } catch (_: SecurityException) { state("unauthorized"); reject(promise, "Allow Nearby devices permission in Android Settings.") }
      catch (error: Exception) { reject(promise, "Bluetooth could not start: ${error.message ?: "unknown error"}.") }
    }
    if (hasPermissions(context)) { granted(); return }
    val permissions = appContext.permissions ?: run { reject(promise, "Bluetooth permission manager is unavailable."); return }
    val required = if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
      else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    permissions.askForPermissions({ responses ->
      main.post {
        if (operation != operationGeneration || destroyed || !foreground) reject(promise, "Bluetooth operation canceled.")
        else if (required.all { responses[it]?.status == PermissionsStatus.GRANTED }) granted()
        else { state("unauthorized"); reject(promise, "Bluetooth permission was denied. Allow Nearby devices (or Location on Android 11 and earlier) in Settings.") }
      }
    }, *required)
  }

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      main.post {
        if (destroyed) return@post
        when (intent?.action) {
          BluetoothAdapter.ACTION_STATE_CHANGED -> {
            publishState()
            val enabled = try { adapter()?.isEnabled == true } catch (_: SecurityException) { false }
            if (!enabled) {
              operationGeneration += 1
              stopScan()
              closeConnection("Bluetooth is turned off or permission was removed.", false)
            }
          }
          BluetoothDevice.ACTION_BOND_STATE_CHANGED -> {
            val current = gatt ?: return@post
            if (!awaitingBond) return@post
            // Read actual GATT device state; an unrelated/spoofed broadcast cannot advance pairing.
            try {
              @Suppress("DEPRECATION")
              val device = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
              if (device?.address != current.device.address) return@post
              when (current.device.bondState) {
                BluetoothDevice.BOND_BONDED -> { awaitingBond = false; subscribe(current) }
                BluetoothDevice.BOND_NONE -> fail("Bluetooth pairing was canceled or rejected. Pair again from Remote Mac.")
              }
            } catch (_: SecurityException) { fail("Bluetooth permission was removed during pairing.") }
          }
        }
      }
    }
  }

  private fun registerReceiver(context: Context) {
    if (receiverContext != null) return
    val filter = IntentFilter().apply {
      addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
      addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
    }
    // Bluetooth broadcasts may originate from a privileged non-system UID.
    if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
    else { @Suppress("DEPRECATION") context.registerReceiver(receiver, filter) }
    receiverContext = context
  }

  private fun registerLifecycle(context: Context) {
    appContext.currentActivity?.let { hostActivity = WeakReference(it) }
    if (lifecycleApplication != null) return
    val application = context.applicationContext as? Application ?: return
    application.registerActivityLifecycleCallbacks(lifecycle)
    lifecycleApplication = application
  }

  private val lifecycle = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityResumed(activity: Activity) {
      if (destroyed) return
      if (activity === hostActivity?.get() || activity === appContext.currentActivity) {
        hostActivity = WeakReference(activity)
        foreground = true
        sendEvent("onAppState", mapOf("active" to true))
      }
    }
    override fun onActivityStopped(activity: Activity) {
      if (destroyed || activity !== hostActivity?.get()) return
      // Expo's onHostPause also runs for system permission/pairing dialogs. A visible
      // host behind those dialogs must remain connected; actual onStop closes it.
      foreground = false
      sendEvent("onAppState", mapOf("active" to false))
      operationGeneration += 1
      stopScan()
      closeConnection("Bluetooth disconnected because Remote Mac entered the background.", false)
    }
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
  }

  private fun publishState() {
    val context = appContext.reactContext?.applicationContext
    val adapter = adapter()
    val value = when {
      context == null || adapter == null -> "unsupported"
      !hasPermissions(context) -> "unauthorized"
      else -> try { if (adapter.isEnabled) "poweredOn" else "poweredOff" } catch (_: SecurityException) { "unauthorized" }
    }
    state(value)
  }

  private fun startScan(service: UUID, promise: Promise) {
    stopScan()
    devices.clear()
    publishDevices()
    val scanner = adapter()?.bluetoothLeScanner ?: run { reject(promise, "Bluetooth scanning is unavailable. Turn Bluetooth on."); return }
    val generation = scanGeneration
    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) = discovered(result)
      override fun onBatchScanResults(results: MutableList<ScanResult>) { results.forEach(::discovered) }
      private fun discovered(result: ScanResult) {
        main.post {
          if (generation != scanGeneration || scannerCallback !== this) return@post
          try {
            val id = result.device.address
            val name = result.scanRecord?.deviceName ?: result.device.name ?: "Remote Mac"
            devices[id] = mapOf("id" to id, "name" to name, "rssi" to result.rssi)
            publishDevices()
          } catch (_: SecurityException) { stopScan(); error("Bluetooth scan permission was removed.") }
        }
      }
      override fun onScanFailed(errorCode: Int) {
        main.post {
          if (generation != scanGeneration || scannerCallback !== this) return@post
          stopScan()
          error("Unable to scan for Macs (Bluetooth $errorCode). Wait a moment and try again.")
        }
      }
    }
    scannerCallback = callback
    try {
      scanner.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(service)).build()),
        ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), callback)
      scanTimer = Runnable { if (generation == scanGeneration) stopScan() }.also { main.postDelayed(it, 15_000) }
      promise.resolve()
    } catch (failure: Exception) {
      stopScan()
      reject(promise, "Could not scan for Macs: ${failure.message ?: "Bluetooth is unavailable"}.")
    }
  }

  private fun stopScan() {
    scanGeneration += 1
    scanTimer?.let(main::removeCallbacks)
    scanTimer = null
    val callback = scannerCallback
    scannerCallback = null
    if (callback != null) try { adapter()?.bluetoothLeScanner?.stopScan(callback) } catch (_: Exception) { }
  }

  private fun connect(id: String, service: UUID, write: UUID, notify: UUID, promise: Promise) {
    val context = appContext.reactContext?.applicationContext ?: run { reject(promise, "Android context is unavailable."); return }
    if (!BluetoothAdapter.checkBluetoothAddress(id)) { reject(promise, "Invalid Bluetooth device identifier. Search for the Mac again."); return }
    serviceUUID = service
    writeUUID = write
    notifyUUID = notify
    connectPromise = promise
    val generation = ++connectionGeneration
    val callback = sessionCallback(generation)
    try {
      val device = adapter()?.getRemoteDevice(id) ?: run { fail("Bluetooth is unavailable."); return }
      gatt = if (Build.VERSION.SDK_INT >= 26) {
        device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE, BluetoothDevice.PHY_LE_1M_MASK, main)
      } else device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
      if (gatt == null) { fail("Android could not open the Bluetooth connection."); return }
      connectTimer = Runnable {
        if (generation == connectionGeneration && !ready) fail("Bluetooth connection timed out. Keep the Mac receiver open and accept the system pairing prompt.")
      }.also { main.postDelayed(it, 30_000) }
    } catch (failure: Exception) { fail("Could not connect over Bluetooth: ${failure.message ?: "connection failed"}.") }
  }

  private fun sessionCallback(generation: Int) = object : BluetoothGattCallback() {
    private fun current(candidate: BluetoothGatt, block: () -> Unit) {
      main.post { if (generation == connectionGeneration && gatt === candidate && !destroyed) block() }
    }
    override fun onConnectionStateChange(candidate: BluetoothGatt, status: Int, newState: Int) = current(candidate) {
      if (status != BluetoothGatt.GATT_SUCCESS) { fail("Bluetooth connection failed (GATT $status)."); return@current }
      when (newState) {
        BluetoothProfile.STATE_CONNECTED -> {
          try {
            candidate.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
            if (!candidate.discoverServices()) fail("Bluetooth service discovery could not start.")
          } catch (_: SecurityException) { fail("Bluetooth connection permission was removed.") }
        }
        BluetoothProfile.STATE_DISCONNECTED -> closeConnection("The Mac Bluetooth connection ended.", false)
      }
    }
    override fun onServicesDiscovered(candidate: BluetoothGatt, status: Int) = current(candidate) {
      if (status != BluetoothGatt.GATT_SUCCESS) { fail("Bluetooth service discovery failed (GATT $status)."); return@current }
      val service = candidate.getService(serviceUUID)
      val tx = service?.getCharacteristic(writeUUID)
      val rx = service?.getCharacteristic(notifyUUID)
      if (tx == null || rx == null || tx.properties and BluetoothGattCharacteristic.PROPERTY_WRITE == 0 || rx.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0) {
        fail("This Bluetooth device does not expose the Remote Mac service."); return@current
      }
      writeCharacteristic = tx
      notifyCharacteristic = rx
      try { if (!candidate.requestMtu(247)) ensureBond(candidate) }
      catch (_: SecurityException) { fail("Bluetooth permission was removed.") }
    }
    override fun onMtuChanged(candidate: BluetoothGatt, value: Int, status: Int) = current(candidate) {
      mtu = if (status == BluetoothGatt.GATT_SUCCESS) value.coerceIn(23, 517) else 23
      if (writeCharacteristic != null && !ready && !awaitingBond && !subscriptionStarted) ensureBond(candidate)
    }
    override fun onServiceChanged(candidate: BluetoothGatt) = current(candidate) {
      fail("The Mac Bluetooth service changed. Reconnect to continue.")
    }
    override fun onDescriptorWrite(candidate: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) = current(candidate) {
      if (descriptor.uuid != CCCD || descriptor.characteristic.uuid != notifyUUID || ready) return@current
      if (status != BluetoothGatt.GATT_SUCCESS) { fail("The encrypted Bluetooth notification subscription failed (GATT $status). Pair again in system Settings."); return@current }
      ready = true
      connectTimer?.let(main::removeCallbacks)
      connectTimer = null
      val promise = connectPromise
      connectPromise = null
      promise?.resolve()
    }
    override fun onCharacteristicWrite(candidate: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) = current(candidate) {
      if (characteristic.uuid != writeUUID || !writeInFlight) return@current
      writeTimer?.let(main::removeCallbacks)
      writeTimer = null
      writeInFlight = false
      if (status != BluetoothGatt.GATT_SUCCESS) { fail("Bluetooth write failed (GATT $status). Input was stopped."); return@current }
      val pending = writes.peekFirst() ?: return@current
      pending.offset += currentChunkLength
      currentChunkLength = 0
      if (pending.offset == pending.bytes.size) {
        writes.removeFirst()
        queuedBytes -= pending.bytes.size
        pending.promise.resolve()
      }
      writeNext()
    }
    override fun onCharacteristicChanged(candidate: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      val copy = value.copyOf()
      current(candidate) { if (characteristic.uuid == notifyUUID) receive(copy) }
    }
    @Deprecated("Legacy callback for Android 12 and earlier")
    override fun onCharacteristicChanged(candidate: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      if (Build.VERSION.SDK_INT >= 33) return
      @Suppress("DEPRECATION") val copy = characteristic.value?.copyOf() ?: return
      current(candidate) { if (characteristic.uuid == notifyUUID) receive(copy) }
    }
  }

  private fun ensureBond(candidate: BluetoothGatt) {
    if (gatt !== candidate || ready || awaitingBond || subscriptionStarted) return
    try {
      when (candidate.device.bondState) {
        BluetoothDevice.BOND_BONDED -> subscribe(candidate)
        BluetoothDevice.BOND_BONDING -> { awaitingBond = true }
        else -> {
          awaitingBond = true
          if (!candidate.device.createBond()) fail("Android could not start Bluetooth pairing. Remove the old pairing in Settings and try again.")
        }
      }
    } catch (_: SecurityException) { fail("Bluetooth pairing permission was denied.") }
  }

  private fun subscribe(candidate: BluetoothGatt) {
    if (gatt !== candidate || ready || subscriptionStarted) return
    val characteristic = notifyCharacteristic ?: run { fail("The Bluetooth response characteristic is missing."); return }
    val descriptor = characteristic.getDescriptor(CCCD) ?: run { fail("The Bluetooth response notification descriptor is missing."); return }
    subscriptionStarted = true
    try {
      if (!candidate.setCharacteristicNotification(characteristic, true)) { fail("Could not enable Bluetooth responses."); return }
      val started = if (Build.VERSION.SDK_INT >= 33) {
        candidate.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
      } else {
        @Suppress("DEPRECATION")
        descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        @Suppress("DEPRECATION")
        candidate.writeDescriptor(descriptor)
      }
      if (!started) fail("Could not subscribe to encrypted Bluetooth responses.")
    } catch (_: SecurityException) { fail("Bluetooth notification permission was denied.") }
  }

  private fun send(message: String, promise: Promise) {
    if (!ready || gatt == null || !foreground) { reject(promise, "Bluetooth is not connected."); return }
    val payload = message.toByteArray(Charsets.UTF_8)
    if (payload.isEmpty() || payload.size > MAX_MESSAGE_BYTES) { reject(promise, "Bluetooth message must be between 1 and $MAX_MESSAGE_BYTES bytes."); return }
    val frame = ByteBuffer.allocate(payload.size + 4).putInt(payload.size).put(payload).array()
    if (queuedBytes + frame.size > MAX_QUEUED_BYTES) {
      reject(promise, "Bluetooth input queue is full. Reconnect before sending more input.")
      fail("Bluetooth could not keep up with input. Disconnected to avoid delayed controls.")
      return
    }
    writes.addLast(PendingWrite(frame, promise, SystemClock.elapsedRealtime()))
    queuedBytes += frame.size
    writeNext()
  }

  private fun writeNext() {
    if (writeInFlight || !ready) return
    val candidate = gatt ?: return
    val characteristic = writeCharacteristic ?: return
    val pending = writes.peekFirst() ?: return
    val remainingAge = MAX_INPUT_AGE_MS - (SystemClock.elapsedRealtime() - pending.queuedAt)
    if (remainingAge <= 0) { fail("Bluetooth input became stale. Disconnected to prevent delayed controls."); return }
    currentChunkLength = minOf(mtu - 3, 512, pending.bytes.size - pending.offset)
    val value = pending.bytes.copyOfRange(pending.offset, pending.offset + currentChunkLength)
    try {
      val started = if (Build.VERSION.SDK_INT >= 33) {
        candidate.writeCharacteristic(characteristic, value, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
      } else {
        @Suppress("DEPRECATION")
        characteristic.value = value
        characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        @Suppress("DEPRECATION")
        candidate.writeCharacteristic(characteristic)
      }
      if (!started) { fail("Bluetooth could not send input. Reconnect to continue."); return }
      writeInFlight = true
      val generation = connectionGeneration
      writeTimer = Runnable {
        if (generation == connectionGeneration && writeInFlight) fail("Bluetooth input timed out. Disconnected to avoid stuck controls.")
      }.also { main.postDelayed(it, remainingAge) }
    } catch (_: SecurityException) { fail("Bluetooth connection permission was removed.") }
    catch (failure: Exception) { fail("Bluetooth write failed: ${failure.message ?: "unknown error"}.") }
  }

  private fun receive(bytes: ByteArray) {
    if (bytes.isEmpty()) return
    // At most one incomplete frame plus one ATT notification may be buffered.
    if (incoming.size + bytes.size > MAX_MESSAGE_BYTES + 4 + 517) { fail("Bluetooth response exceeded the frame limit."); return }
    if (incoming.isEmpty()) {
      val generation = connectionGeneration
      assemblyTimer = Runnable {
        if (generation == connectionGeneration && incoming.isNotEmpty()) fail("Bluetooth response assembly timed out.")
      }.also { main.postDelayed(it, 5_000) }
    }
    incoming += bytes
    while (incoming.size >= 4) {
      val size = ByteBuffer.wrap(incoming, 0, 4).int
      if (size !in 1..MAX_MESSAGE_BYTES) { fail("Bluetooth response contains an invalid frame length."); return }
      if (incoming.size < size + 4) break
      val payload = incoming.copyOfRange(4, size + 4)
      incoming = incoming.copyOfRange(size + 4, incoming.size)
      val data = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(payload)).toString()
      } catch (_: Exception) { fail("Bluetooth response is not valid UTF-8."); return }
      // Subscription may deliver the hello before its descriptor callback; JS subscribes first.
      sendEvent("onData", mapOf("data" to data))
      assemblyTimer?.let(main::removeCallbacks)
      assemblyTimer = null
      if (incoming.isNotEmpty()) {
        val generation = connectionGeneration
        assemblyTimer = Runnable {
          if (generation == connectionGeneration && incoming.isNotEmpty()) fail("Bluetooth response assembly timed out.")
        }.also { main.postDelayed(it, 5_000) }
      }
    }
  }

  private fun fail(message: String) = closeConnection(message, true)

  private fun closeConnection(message: String, reportError: Boolean) {
    val old = gatt
    val hadConnection = old != null || connectPromise != null || ready
    // Invalidate before disconnect/close, which may trigger callbacks synchronously on some stacks.
    connectionGeneration += 1
    gatt = null
    ready = false
    awaitingBond = false
    subscriptionStarted = false
    connectTimer?.let(main::removeCallbacks)
    connectTimer = null
    assemblyTimer?.let(main::removeCallbacks)
    assemblyTimer = null
    writeTimer?.let(main::removeCallbacks)
    writeTimer = null
    val pendingConnect = connectPromise
    connectPromise = null
    pendingConnect?.let { reject(it, message) }
    while (writes.isNotEmpty()) reject(writes.removeFirst().promise, message)
    queuedBytes = 0
    writeInFlight = false
    currentChunkLength = 0
    incoming = ByteArray(0)
    writeCharacteristic = null
    notifyCharacteristic = null
    serviceUUID = null
    writeUUID = null
    notifyUUID = null
    mtu = 23
    if (old != null) {
      try { old.disconnect() } catch (_: Exception) { }
      try { old.close() } catch (_: Exception) { }
    }
    if (reportError) error(message)
    if (hadConnection) sendEvent("onDisconnected", mapOf("message" to message))
  }

  private fun publishDevices() = sendEvent("onDevices", mapOf("devices" to devices.values.sortedBy { it["name"] as String }))
  private fun state(value: String) = sendEvent("onState", mapOf("state" to value))
  private fun error(message: String) = sendEvent("onError", mapOf("message" to message))
  private fun reject(promise: Promise, message: String) = promise.reject("ERR_BLUETOOTH_TRANSPORT", message, null)

  companion object {
    private const val MAX_MESSAGE_BYTES = 16_384
    private const val MAX_QUEUED_BYTES = 32_768
    private const val MAX_INPUT_AGE_MS = 2_000L
    private val CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
  }
}
