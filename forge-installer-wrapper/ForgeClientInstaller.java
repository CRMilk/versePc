import java.io.*;
import java.lang.reflect.*;
import java.net.*;
import java.util.function.Predicate;

public class ForgeClientInstaller {
    public static void main(String[] args) throws Exception {
        System.setProperty("java.awt.headless", "true");
        System.setProperty("java.net.preferIPv4Stack", "true");

        if (args.length < 2) {
            System.err.println("Usage: ForgeClientInstaller <installerJar> <targetDir>");
            System.exit(1);
        }

        File installerJar = new File(args[0]);
        File targetDir = new File(args[1]);

        if (!installerJar.exists()) {
            System.err.println("[ForgeInstaller] Installer JAR not found: " + installerJar.getAbsolutePath());
            System.exit(2);
        }

        URLClassLoader cl = new URLClassLoader(new URL[]{installerJar.toURI().toURL()}, ClassLoader.getSystemClassLoader());
        Thread.currentThread().setContextClassLoader(cl);

        try {
            Class<?> versionInfoClass = Class.forName("net.minecraftforge.installer.VersionInfo", true, cl);
            Method getVersionTarget = versionInfoClass.getMethod("getVersionTarget");
            Object target = getVersionTarget.invoke(null);
            System.out.println("[ForgeInstaller] VersionInfo initialized: " + target);
        } catch (Throwable e) {
            System.err.println("[ForgeInstaller] Failed to init VersionInfo: " + e.getMessage());
            e.printStackTrace();
            System.exit(2);
        }

        try {
            Class<?> clientInstallClass = Class.forName("net.minecraftforge.installer.ClientInstall", true, cl);
            Object installer = clientInstallClass.getConstructor().newInstance();

            Class<?> predicateClass;
            try {
                predicateClass = Class.forName("java.util.function.Predicate", true, cl);
            } catch (ClassNotFoundException e) {
                predicateClass = Class.forName("com.google.common.base.Predicate", true, cl);
            }

            final Class<?> finalPredicateClass = predicateClass;
            InvocationHandler handler = (proxy, method, a) -> {
                String methodName = method.getName();
                if (methodName.equals("test") || methodName.equals("apply")) return true;
                if (methodName.equals("equals")) return proxy == a[0];
                if (methodName.equals("hashCode")) return System.identityHashCode(proxy);
                if (methodName.equals("toString")) return "alwaysTrue";
                return null;
            };
            Object alwaysTrue = java.lang.reflect.Proxy.newProxyInstance(cl, new Class<?>[]{finalPredicateClass}, handler);

            Method runMethod = clientInstallClass.getMethod("run", File.class, predicateClass);
            System.out.println("[ForgeInstaller] Calling ClientInstall.run(" + targetDir.getAbsolutePath() + ", alwaysTrue)");
            boolean result = (Boolean) runMethod.invoke(installer, targetDir, alwaysTrue);
            System.out.println("[ForgeInstaller] ClientInstall.run() returned: " + result);
            System.exit(result ? 0 : 1);
        } catch (InvocationTargetException e) {
            System.err.println("[ForgeInstaller] ClientInstall failed: " + e.getTargetException().getMessage());
            e.getTargetException().printStackTrace();
            System.exit(3);
        } catch (Throwable e) {
            System.err.println("[ForgeInstaller] ClientInstall failed: " + e.getMessage());
            e.printStackTrace();
            System.exit(3);
        }
    }
}
