package org.chromium.support_lib_boundary;

import java.lang.reflect.InvocationHandler;

/**
 * Minimal Chromium WebView Support Library boundary interface matching
 * WebViewProviderBoundaryInterface.java.
 */
public interface WebViewProviderBoundaryInterface {
    /* ScriptHandlerBoundaryInterface */
    InvocationHandler addDocumentStartJavaScript(String script, String[] allowedOriginRules);

    /* ProfileBoundaryInterface */
    InvocationHandler getProfile();
}
