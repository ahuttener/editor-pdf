package com.cybersecinfo.editorpdf.print;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.util.Base64;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.FileOutputStream;
import java.io.IOException;

// Imprime um PDF (base64) com a tela de impressão do Android (PrintManager)
@CapacitorPlugin(name = "Printer")
public class PrintPlugin extends Plugin {

    @PluginMethod
    public void printPdf(PluginCall call) {
        String b64 = call.getString("data");
        if (b64 == null) {
            call.reject("PDF ausente");
            return;
        }
        final byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
        final String name = call.getString("name", "Documento");
        PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
            @Override
            public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, CancellationSignal cancel,
                                 LayoutResultCallback callback, Bundle extras) {
                if (cancel.isCanceled()) {
                    callback.onLayoutCancelled();
                    return;
                }
                callback.onLayoutFinished(new PrintDocumentInfo.Builder(name)
                        .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).build(), true);
            }

            @Override
            public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancel,
                                WriteResultCallback callback) {
                try (FileOutputStream out = new FileOutputStream(destination.getFileDescriptor())) {
                    out.write(bytes);
                    callback.onWriteFinished(new PageRange[] { PageRange.ALL_PAGES });
                } catch (IOException e) {
                    callback.onWriteFailed(e.getMessage());
                }
            }
        };
        getActivity().runOnUiThread(() -> {
            PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
            pm.print(name, adapter, null);
            call.resolve();
        });
    }
}
