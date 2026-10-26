package com.remotemac.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.util.ArrayDeque

/** All state is confined to Android's main looper; stale callbacks cannot repopulate a stopped scan. */
class LanDiscoveryModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var manager: NsdManager? = null
  private var listener: NsdManager.DiscoveryListener? = null
  private var multicastLock: WifiManager.MulticastLock? = null
  private var generation = 0
  private val known = mutableSetOf<String>()
  private val resolved = mutableMapOf<String, Map<String, Any>>()
  private val queue = ArrayDeque<Pair<Int, NsdServiceInfo>>()
  private var activeResolve: NsdManager.ResolveListener? = null

  override fun definition() = ModuleDefinition {
    Name("LanDiscovery")
    Events("onChange", "onError")

    AsyncFunction("requestLocalNetworkAccess") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) { promise.resolve(false); return@AsyncFunction }
      // SDK 58 currently targets API 36. This also supports a future target-37
      // upgrade when ACCESS_LOCAL_NETWORK is declared in the app manifest.
      if (Build.VERSION.SDK_INT >= 37 && context.applicationInfo.targetSdkVersion >= 37) {
        val permissions = appContext.permissions
        if (permissions == null) { promise.resolve(false); return@AsyncFunction }
        permissions.askForPermissions({ responses ->
          promise.resolve(responses["android.permission.ACCESS_LOCAL_NETWORK"]?.status == PermissionsStatus.GRANTED)
        }, "android.permission.ACCESS_LOCAL_NETWORK")
      } else { promise.resolve(true) }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("start") { serviceType: String -> start(serviceType) }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") { stop() }.runOnQueue(Queues.MAIN)
    OnActivityEntersBackground { main.post { stop() } }
    OnDestroy { main.post { stop() } }
  }

  private fun start(serviceType: String) {
    stop()
    if (!Regex("^_[a-zA-Z0-9-]+\\._tcp$").matches(serviceType)) {
      error("Invalid discovery service type.")
      return
    }
    val context = appContext.reactContext?.applicationContext ?: run {
      error("Android application context is unavailable.")
      return
    }
    val nsd = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: run {
      error("Network service discovery is unavailable on this device.")
      return
    }
    manager = nsd
    val scanGeneration = generation
    val discovery = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(type: String) = Unit
      override fun onDiscoveryStopped(type: String) = Unit
      override fun onStartDiscoveryFailed(type: String, code: Int) {
        main.post {
          if (generation != scanGeneration) return@post
          error("Unable to search for Macs (NSD $code). Check Wi-Fi and Local Network permission.")
          stop()
        }
      }
      override fun onStopDiscoveryFailed(type: String, code: Int) {
        main.post { if (generation == scanGeneration) error("Could not stop network discovery (NSD $code).") }
      }
      override fun onServiceFound(info: NsdServiceInfo) {
        main.post {
          if (generation != scanGeneration || info.serviceType.trimEnd('.') != serviceType) return@post
          val id = id(info)
          if (known.add(id)) { queue.add(scanGeneration to info); resolveNext() }
        }
      }
      override fun onServiceLost(info: NsdServiceInfo) {
        main.post {
          if (generation != scanGeneration) return@post
          known.remove(id(info))
          resolved.remove(id(info))
          publish()
        }
      }
    }
    listener = discovery
    try {
      val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager
      multicastLock = wifi?.createMulticastLock("RemoteMacDiscovery")?.apply {
        setReferenceCounted(false)
        acquire()
      }
      nsd.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, discovery)
    } catch (exception: SecurityException) {
      error("Local network access is denied. Allow Remote Mac to access your local network in Android Settings.")
      stop()
    } catch (exception: Exception) {
      error("Unable to start network discovery: ${exception.message ?: "Wi-Fi is unavailable"}.")
      stop()
    }
  }

  @Suppress("DEPRECATION") // Serial fallback supports the full Expo Android version range.
  private fun resolveNext() {
    if (listener == null || activeResolve != null) return
    var item: Pair<Int, NsdServiceInfo>? = queue.pollFirst()
    while (item != null && (item.first != generation || !known.contains(id(item.second)))) item = queue.pollFirst()
    val (scanGeneration, info) = item ?: return
    val nsd = manager ?: return
    val resolver = object : NsdManager.ResolveListener {
      override fun onResolveFailed(serviceInfo: NsdServiceInfo, code: Int) {
        main.post {
          if (activeResolve === this) activeResolve = null
          if (generation == scanGeneration && known.remove(id(serviceInfo))) {
            error("Found ${serviceInfo.serviceName}, but could not resolve it (NSD $code). Try Search again.")
          }
          resolveNext()
        }
      }
      override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
        main.post {
          if (activeResolve === this) activeResolve = null
          val id = id(serviceInfo)
          if (generation == scanGeneration && known.contains(id)) {
            val address = if (Build.VERSION.SDK_INT >= 34) {
              serviceInfo.hostAddresses.firstOrNull { it is Inet4Address } ?: serviceInfo.hostAddresses.firstOrNull()
            } else { serviceInfo.host }
            // Numeric IPv6 without a zone works; scoped IPv6 needs a platform URL
            // implementation. Report its limitation rather than silently corrupt it.
            val host = address?.hostAddress
            if (host != null && !host.contains('%') && serviceInfo.port in 1..65535) {
              resolved[id] = mapOf("id" to id, "name" to serviceInfo.serviceName, "host" to host, "port" to serviceInfo.port)
              publish()
            } else {
              error("Found ${serviceInfo.serviceName}, but no usable address was resolved. Use the Mac's IPv4 address manually.")
            }
          }
          resolveNext()
        }
      }
    }
    activeResolve = resolver
    try { nsd.resolveService(info, resolver) }
    catch (exception: Exception) {
      activeResolve = null
      error("Could not resolve ${info.serviceName}. Check Local Network permission.")
      resolveNext()
    }
  }

  private fun stop() {
    generation += 1
    val old = listener
    listener = null
    if (old != null) {
      try { manager?.stopServiceDiscovery(old) } catch (_: Exception) { }
    }
    // Old resolve callbacks are allowed to finish but are discarded by generation;
    // serializing through them avoids FAILURE_ALREADY_ACTIVE on older Android.
    queue.clear()
    known.clear()
    resolved.clear()
    try { multicastLock?.takeIf { it.isHeld }?.release() } catch (_: Exception) { }
    multicastLock = null
    publish()
  }

  private fun id(info: NsdServiceInfo) = "${info.serviceName}.${info.serviceType.trimEnd('.')}.local."
  private fun publish() = sendEvent("onChange", mapOf("macs" to resolved.values.sortedBy { it["name"] as String }))
  private fun error(message: String) = sendEvent("onError", mapOf("message" to message))
}
