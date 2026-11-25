package org.chromium.support_lib_boundary;

import android.webkit.WebView;

import java.lang.reflect.InvocationHandler;

/**
 * Minimal Chromium WebView Support Library boundary interface matching
 * android_webview/support_library/boundary_interfaces/src/org/chromium/support_lib_boundary/WebViewProviderFactoryBoundaryInterface.java.
 */
public interface WebViewProviderFactoryBoundaryInterface {
    String[] getSupportedFeatures();

    /* WebViewProviderBoundaryInterface */
    InvocationHandler createWebView(WebView webview);

    /* ProfileStoreBoundaryInterface */
    InvocationHandler getProfileStore();
}
