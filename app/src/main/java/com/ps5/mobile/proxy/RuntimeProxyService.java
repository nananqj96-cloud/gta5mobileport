package com.ps5.mobile.proxy;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import com.ps5.mobile.GameActivity;
import com.ps5.mobile.stats.StatsMonitor;

import java.io.IOException;

/**
 * Lightweight Android Foreground Service that keeps the localhost COOP/COEP proxy server
 * and Android hardware telemetry monitor alive while GTA V runs inside Chrome's 64-bit WebGPU engine.
 */
public final class RuntimeProxyService extends Service {

    public static final String ACTION_STOP = "com.ps5.mobile.STOP_PROXY";
    private static final String CHANNEL_ID = "ps5_runtime_proxy";
    private static final int NOTIFICATION_ID = 505;

    private static volatile LocalPlayProxyServer serverInstance;
    private static volatile StatsMonitor statsInstance;

    public static synchronized int ensureStarted(Context context) throws IOException {
        Context app = context.getApplicationContext();
        if (serverInstance == null) {
            serverInstance = new LocalPlayProxyServer(app);
        }
        int port = serverInstance.start();

        if (statsInstance == null) {
            statsInstance = new StatsMonitor(app, snap -> {
                LocalPlayProxyServer s = serverInstance;
                if (s != null) s.updateStats(snap);
            });
            statsInstance.start();
        }

        Intent svc = new Intent(app, RuntimeProxyService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            app.startForegroundService(svc);
        } else {
            app.startService(svc);
        }
        return port;
    }

    public static synchronized void shutdownAll(Context context) {
        if (statsInstance != null) {
            statsInstance.stop();
            statsInstance = null;
        }
        if (serverInstance != null) {
            serverInstance.stop();
            serverInstance = null;
        }
        context.getApplicationContext().stopService(new Intent(context.getApplicationContext(), RuntimeProxyService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            shutdownAll(this);
            stopSelf();
            return START_NOT_STICKY;
        }

        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "PS5 Runtime Proxy", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps COOP/COEP local bridge and hardware telemetry active while playing");
            nm.createNotificationChannel(ch);
        }

        int piFlags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent openPs5 = PendingIntent.getActivity(
                this, 0,
                new Intent(this, GameActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK),
                piFlags);
        PendingIntent stopAction = PendingIntent.getService(
                this, 1,
                new Intent(this, RuntimeProxyService.class).setAction(ACTION_STOP),
                piFlags);

        int port = serverInstance != null ? serverInstance.getPort() : LocalPlayProxyServer.PREFERRED_PORT;
        Notification.Builder nb = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        Notification notif = nb
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle("PS5 Mobile Runtime Active")
                .setContentText("COOP/COEP bridge & live telemetry on localhost:" + port)
                .setContentIntent(openPs5)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Stop", stopAction).build())
                .build();

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notif);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        shutdownAll(this);
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (statsInstance != null) {
            statsInstance.stop();
            statsInstance = null;
        }
        if (serverInstance != null) {
            serverInstance.stop();
            serverInstance = null;
        }
        super.onDestroy();
    }
}
